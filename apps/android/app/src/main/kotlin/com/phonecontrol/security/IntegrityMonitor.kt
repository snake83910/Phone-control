package com.phonecontrol.security

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Debug
import android.provider.Settings
import android.util.Log
import com.phonecontrol.BuildConfig
import com.phonecontrol.core.rules.INTEGRITY_REPEAT_AFTER_MILLIS
import com.phonecontrol.core.rules.IntegrityFinding
import com.phonecontrol.core.rules.IntegrityObservation
import com.phonecontrol.core.rules.IntegritySignals
import com.phonecontrol.core.rules.IntegrityState
import com.phonecontrol.core.rules.ROOT_PACKAGES
import com.phonecontrol.core.rules.SU_BINARY_PATHS
import com.phonecontrol.core.rules.evaluateIntegrity
import com.phonecontrol.core.rules.planIntegrityReports
import com.phonecontrol.sync.EventRecorder
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * Surveillance de l'intégrité du terminal.
 *
 * Collecte les signaux qu'Android laisse observer, les soumet à la politique
 * (`core-rules/IntegrityRules.kt`, testée sans téléphone) et remonte des
 * événements de sécurité. **Ne bloque rien** : l'arbitrage appartient au
 * serveur, qui seul dispose du contexte — un téléphone d'atelier a de bonnes
 * raisons d'avoir le débogage USB actif, un téléphone de tournée non.
 *
 * La collecte est délibérément superficielle : lecture de quelques chemins,
 * d'un réglage système, d'un drapeau du processus. Aucune tentative de sonder
 * plus profondément, aucune course à l'obfuscation. Un terminal réellement
 * compromis passe entre les mailles, c'est admis et écrit — voir
 * `IntegrityRules`.
 */
@Singleton
class IntegrityMonitor @Inject constructor(
    @ApplicationContext private val context: Context,
    private val secureStore: SecureStore,
    private val events: EventRecorder,
    private val json: Json,
) {

    /**
     * Observe, décide, remonte. Appelé au début de chaque synchronisation.
     *
     * Retourne les constats effectivement remontés, pour les tests et le
     * diagnostic.
     */
    suspend fun check(nowMillis: Long = System.currentTimeMillis()): List<IntegrityObservation> {
        val observations = evaluateIntegrity(collect())
        val report = planIntegrityReports(
            observations,
            readState(),
            nowMillis,
            INTEGRITY_REPEAT_AFTER_MILLIS,
        )

        for (observation in report.toEmit) {
            events.recordSecurity(
                type = observation.eventType,
                severity = observation.severity,
                metadata = mapOf(
                    "evidence" to observation.evidence.joinToString(" ; "),
                    "androidVersion" to Build.VERSION.RELEASE,
                    "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
                ),
                occurredAtMillis = nowMillis,
            )
            Log.w(TAG, "Constat d'intégrité : ${observation.eventType}")
        }

        writeState(report.state)
        return report.toEmit
    }

    /** Ce qu'Android laisse voir, sans interprétation. */
    fun collect(): IntegritySignals = IntegritySignals(
        suBinariesFound = SU_BINARY_PATHS.filter { path ->
            runCatching { File(path).exists() }.getOrDefault(false)
        },
        rootPackagesFound = ROOT_PACKAGES.filter { isInstalled(it) },
        buildTags = Build.TAGS,
        debuggerAttached = Debug.isDebuggerConnected(),
        debuggableBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
        adbEnabled = globalFlag(Settings.Global.ADB_ENABLED),
        developerOptionsEnabled = globalFlag(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED),
        signatureMatchesExpected = signatureVerdict(),
    )

    private fun isInstalled(packageName: String): Boolean = runCatching {
        context.packageManager.getPackageInfo(packageName, 0)
        true
    }.getOrDefault(false)

    private fun globalFlag(name: String): Boolean = runCatching {
        Settings.Global.getInt(context.contentResolver, name, 0) == 1
    }.getOrDefault(false)

    /**
     * Compare la signature de l'APK à celle attendue.
     *
     * `null` quand aucune attente n'est configurée, ou quand la lecture échoue :
     * « pas vérifié » et « faux » sont deux choses différentes, et les confondre
     * produirait une alerte critique après un simple incident.
     *
     * L'attente est fixée à la compilation. C'est le maillon faible de ce
     * contrôle — celui qui reconstruit l'application peut aussi changer la
     * valeur attendue — et il n'attrape donc que le repackaging naïf. La forme
     * robuste consisterait à faire descendre l'empreinte depuis le serveur à
     * l'enrôlement : elle est notée en Phase 7, avec l'épinglage de certificat.
     */
    fun signatureVerdict(): Boolean? {
        val expected = BuildConfig.EXPECTED_SIGNATURE_SHA256.takeIf { it.isNotBlank() }
            ?: return null
        val observed = signatureDigest() ?: return null
        return observed.equals(expected, ignoreCase = true)
    }

    /** SHA-256 du certificat de signature, en hexadécimal. */
    fun signatureDigest(): String? = runCatching {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        val info = context.packageManager.getPackageInfo(context.packageName, flags)

        val certificate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners?.firstOrNull()
        } else {
            @Suppress("DEPRECATION")
            info.signatures?.firstOrNull()
        } ?: return null

        MessageDigest.getInstance("SHA-256")
            .digest(certificate.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }.getOrNull()

    // --- Persistance de la cadence ------------------------------------------

    private fun readState(): IntegrityState {
        val raw = secureStore.integrityStateJson ?: return IntegrityState()
        return runCatching {
            val entries = json.parseToJsonElement(raw).jsonObject.mapNotNull { (key, value) ->
                val finding = runCatching { IntegrityFinding.valueOf(key) }.getOrNull()
                finding?.let { it to value.jsonPrimitive.long }
            }
            IntegrityState(entries.toMap())
        }.getOrElse { IntegrityState() }
    }

    private fun writeState(state: IntegrityState) {
        val payload = JsonObject(
            state.reportedAtMillis.entries.associate { (finding, millis) ->
                finding.name to JsonPrimitive(millis)
            },
        )
        secureStore.integrityStateJson = json.encodeToString(JsonObject.serializer(), payload)
    }

    private companion object {
        const val TAG = "IntegrityMonitor"
    }
}
