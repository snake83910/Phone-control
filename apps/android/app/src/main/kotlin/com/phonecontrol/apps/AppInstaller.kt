package com.phonecontrol.apps

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.util.Log
import com.phonecontrol.core.rules.ExpectedApk
import com.phonecontrol.core.rules.InstallDecision
import com.phonecontrol.core.rules.InstallRefusal
import com.phonecontrol.core.rules.InstalledApp
import com.phonecontrol.core.rules.ObservedApk
import com.phonecontrol.core.rules.decideInstall
import com.phonecontrol.core.rules.isAnomaly
import com.phonecontrol.data.remote.InstalledAppRequest
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.kiosk.KioskController
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Installation d'une application depuis un APK.
 *
 * **C'est la fonction la plus dangereuse du systeme.** « Installe l'APK qui se
 * trouve la » est une execution de code arbitraire sur la flotte entiere. Tout
 * ce qui suit decoule de cette phrase.
 *
 * Le telephone ne fait confiance a rien qu'il n'ait verifie lui-meme :
 *
 * 1. il calcule l'empreinte du fichier **pendant** le telechargement, et la
 *    compare a celle annoncee ;
 * 2. il lit le certificat de signature de l'APK telecharge et le compare a
 *    celui annonce ;
 * 3. il compare a ce qui est deja installe, et refuse un retour en arriere ou
 *    un changement de signataire.
 *
 * La decision elle-meme n'est pas ici : elle vit dans `decideInstall`, pure et
 * testee sur des scenarios partages. Cette classe telecharge, constate, obeit,
 * et rapporte.
 *
 * Sans Device Owner, elle ne fait rien et le dit — installer exigerait sinon
 * une confirmation du chauffeur, qui n'a pas a arbitrer un deploiement (§67).
 */
@Singleton
class AppInstaller @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: PhoneControlApi,
    private val kiosk: KioskController,
) {

    /**
     * Ce que le telephone constate du fichier, decision et affichage compris.
     *
     * [observed] ne porte que ce qui entre dans la decision ; le nom de version
     * est lisible par un humain et sert au rapport, pas au verdict. Les
     * separer evite d'alourdir les regles pures d'un champ qu'elles ignorent.
     */
    private data class Inspected(
        val observed: ObservedApk,
        val versionName: String,
    )

    /** Ce qui est arrive, dit en une phrase que le serveur journalise. */
    sealed interface Outcome {
        data class Installed(val packageName: String, val versionName: String) : Outcome
        data class Refused(val reason: InstallRefusal) : Outcome
        data class Failed(val message: String) : Outcome
    }

    suspend fun install(expected: ExpectedApk): Outcome {
        if (!kiosk.isDeviceOwner) {
            return Outcome.Failed(
                "Device Owner absent : aucune installation silencieuse possible.",
            )
        }

        val file = File(context.cacheDir, "download-${expected.packageId}.apk")
        try {
            val sha256 = download(expected.packageId, file)
                ?: return Outcome.Failed("Téléchargement impossible.")

            val inspected = inspect(file, sha256)
                ?: return Outcome.Failed("APK illisible ou non signé.")
            val observed = inspected.observed

            val decision = decideInstall(expected, observed, installedApp(observed.packageName))
            if (decision is InstallDecision.Refuse) {
                if (isAnomaly(decision.reason)) {
                    Log.e(TAG, "Installation refusée : ${decision.reason}")
                } else {
                    Log.i(TAG, "Rien à faire : ${decision.reason}")
                }
                return Outcome.Refused(decision.reason)
            }

            val error = commit(file, observed.packageName)
            if (error != null) return Outcome.Failed(error)

            // L'identité réelle remonte au serveur : c'est ce qui lui permettra
            // de vérifier le nom de paquet lors des déploiements suivants.
            runCatching {
                api.reportInstalledApp(
                    InstalledAppRequest(
                        packageId = expected.packageId,
                        packageName = observed.packageName,
                        versionName = inspected.versionName,
                        versionCode = observed.versionCode.toInt(),
                    ),
                )
            }

            return Outcome.Installed(observed.packageName, inspected.versionName)
        } finally {
            // Le fichier ne survit pas à l'opération, réussie ou non : un APK
            // oublié dans le cache est un fichier exécutable de plus sur le
            // téléphone, et il n'a plus aucune raison d'exister.
            file.delete()
        }
    }

    suspend fun uninstall(packageName: String): Outcome {
        if (!kiosk.isDeviceOwner) {
            return Outcome.Failed("Device Owner absent : désinstallation impossible.")
        }
        if (packageName == context.packageName) {
            // Se desinstaller soi-meme couperait tout moyen de revenir.
            return Outcome.Failed(
                "L'application de gestion ne peut pas se désinstaller elle-même.",
            )
        }

        val installer = context.packageManager.packageInstaller
        val (intent, receiver) = pendingResult()

        return try {
            installer.uninstall(packageName, intent.intentSender)
            val status = withTimeoutOrNull(OPERATION_TIMEOUT_MS) { receiver.await() }
            when {
                status == null -> Outcome.Failed("Désinstallation sans réponse du système.")
                status.first == PackageInstaller.STATUS_SUCCESS ->
                    Outcome.Installed(packageName, "")
                else -> Outcome.Failed(status.second)
            }
        } catch (error: Exception) {
            Outcome.Failed(error.message ?: "Désinstallation impossible.")
        } finally {
            unregister(receiver)
        }
    }

    /**
     * Telechargement, avec calcul de l'empreinte dans le meme passage.
     *
     * Le flux n'est jamais mis en memoire : un APK de quarante mega-octets
     * ferait tomber l'application sur un telephone d'entree de gamme, et le
     * parc en est fait.
     */
    private suspend fun download(packageId: String, destination: File): String? =
        withContext(Dispatchers.IO) {
            val response = runCatching { api.downloadAppPackage(packageId) }.getOrNull()
            if (response?.isSuccessful != true) {
                Log.e(TAG, "Téléchargement refusé : ${response?.code()}")
                return@withContext null
            }

            val body = response.body() ?: return@withContext null
            val digest = MessageDigest.getInstance("SHA-256")

            runCatching {
                body.byteStream().use { input ->
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                        }
                    }
                }
                digest.digest().joinToString("") { "%02x".format(it) }
            }.getOrElse { error ->
                Log.e(TAG, "Téléchargement interrompu : ${error.message}")
                null
            }
        }

    /**
     * Lecture de l'APK telecharge : nom de paquet, version, signataire.
     *
     * C'est ici que le telephone apprend ce qu'il tient reellement. Le serveur,
     * lui, ne sait pas lire un manifeste binaire — il annonce ce qu'on lui a
     * dit, ce qui n'est pas la meme chose.
     */
    private fun inspect(file: File, sha256: String): Inspected? {
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val info: PackageInfo = runCatching {
            context.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
        }.getOrNull() ?: return null

        val signature = info.signingInfo
            ?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
            ?.firstOrNull()
            ?: return null

        return Inspected(
            observed = ObservedApk(
                sha256 = sha256,
                signingCertSha256 = checksumOf(signature.toByteArray()),
                packageName = info.packageName,
                versionCode = versionCodeOf(info),
            ),
            versionName = info.versionName ?: "",
        )
    }

    private fun installedApp(packageName: String): InstalledApp? {
        val info = runCatching {
            context.packageManager.getPackageInfo(
                packageName,
                PackageManager.GET_SIGNING_CERTIFICATES,
            )
        }.getOrNull() ?: return null

        val signature = info.signingInfo
            ?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
            ?.firstOrNull()
            ?: return null

        return InstalledApp(
            packageName = info.packageName,
            versionCode = versionCodeOf(info),
            signingCertSha256 = checksumOf(signature.toByteArray()),
        )
    }

    /**
     * Empreinte du certificat, dans le format exact que le serveur produit :
     * SHA-256 du DER, encode en base64url **sans remplissage**.
     *
     * Le remplissage compte : `Zm9v` et `Zm9v=` sont deux chaines differentes,
     * et une comparaison stricte les distinguerait. Toutes les installations
     * echoueraient, avec pour seul indice « signature inattendue ».
     */
    private fun checksumOf(der: ByteArray): String =
        Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(der),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            info.versionCode.toLong()
        }

    /** Ecriture de l'APK dans une session, puis validation. */
    private suspend fun commit(file: File, packageName: String): String? =
        withContext(Dispatchers.IO) {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL,
            ).apply { setAppPackageName(packageName) }

            val sessionId = runCatching { installer.createSession(params) }
                .getOrElse { return@withContext "Session d'installation refusée : ${it.message}" }

            val (intent, receiver) = pendingResult()

            try {
                installer.openSession(sessionId).use { session ->
                    session.openWrite("base.apk", 0, file.length()).use { output ->
                        file.inputStream().use { input -> input.copyTo(output) }
                        // Sans `fsync`, la session peut etre validee alors que
                        // des octets sont encore en tampon : l'installation
                        // echoue alors sur un APK « corrompu » qui ne l'est pas.
                        session.fsync(output)
                    }
                    session.commit(intent.intentSender)
                }

                val status = withTimeoutOrNull(OPERATION_TIMEOUT_MS) { receiver.await() }
                when {
                    status == null -> "Installation sans réponse du système."
                    status.first == PackageInstaller.STATUS_SUCCESS -> null
                    else -> status.second
                }
            } catch (error: Exception) {
                runCatching { installer.abandonSession(sessionId) }
                "Installation impossible : ${error.message}"
            } finally {
                unregister(receiver)
            }
        }

    /**
     * Recepteur ephemere pour le resultat d'une operation.
     *
     * Enregistre dynamiquement plutot que declare au manifeste : ce recepteur
     * n'a de sens que pendant une operation, et un recepteur exporte en
     * permanence serait un point d'entree de plus dans l'application.
     */
    private fun pendingResult(): Pair<PendingIntent, ResultReceiver> {
        val action = "$RESULT_ACTION.${System.nanoTime()}"
        val receiver = ResultReceiver()

        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        receiver.registered = true

        val intent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(action).setPackage(context.packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        return intent to receiver
    }

    private fun unregister(receiver: ResultReceiver) {
        if (!receiver.registered) return
        runCatching { context.unregisterReceiver(receiver) }
        receiver.registered = false
    }

    private inner class ResultReceiver : BroadcastReceiver() {
        var registered = false
        private val result = CompletableDeferred<Pair<Int, String>>()

        suspend fun await(): Pair<Int, String> = result.await()

        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE,
            )
            val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                ?: "Code $status"

            // STATUS_PENDING_USER_ACTION ne devrait jamais arriver en Device
            // Owner. S'il arrive, c'est que le privilege n'est pas ce qu'on
            // croit : on le traite comme un echec plutot que d'ouvrir une boite
            // de dialogue au chauffeur, qui n'a pas a arbitrer un deploiement.
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Log.e(
                    TAG,
                    "Le système demande une confirmation : le Device Owner n'est pas effectif.",
                )
                result.complete(
                    PackageInstaller.STATUS_FAILURE to
                        "Le système exige une confirmation manuelle : Device Owner non effectif.",
                )
                return
            }

            result.complete(status to message)
        }
    }

    private companion object {
        const val TAG = "AppInstaller"
        const val RESULT_ACTION = "com.phonecontrol.APP_INSTALL_RESULT"

        /**
         * Au-dela, on considere que le systeme ne repondra pas. Genereux a
         * dessein : l'installation d'une application volumineuse sur un
         * telephone d'entree de gamme prend du temps.
         */
        const val OPERATION_TIMEOUT_MS = 180_000L
    }
}
