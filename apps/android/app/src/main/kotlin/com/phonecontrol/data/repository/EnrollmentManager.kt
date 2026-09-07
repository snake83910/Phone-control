package com.phonecontrol.data.repository

import android.content.Context
import android.os.Build
import android.util.Log
import com.phonecontrol.BuildConfig
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.local.DepotEntity
import com.phonecontrol.data.remote.EnrollRequest
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.kiosk.KioskController
import com.phonecontrol.schedule.LockScheduler
import com.phonecontrol.security.SecureStore
import com.phonecontrol.sync.SyncEngine
import com.phonecontrol.sync.SyncWorker
import com.phonecontrol.sync.toEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.Json

/**
 * Enrôlement du téléphone.
 *
 * En production (Phase 5), le jeton arrive dans le QR code de provisioning et
 * l'enrôlement se fait sans aucune saisie. En Phase 4, il est saisi à la main :
 * c'est le seul moyen de valider la chaîne complète sur un terminal de test
 * avant que le Device Owner ne soit en place.
 *
 * L'opération est **idempotente côté serveur** : le jeton est à usage unique, un
 * second appel échoue proprement plutôt que de créer un doublon.
 */
@Singleton
class EnrollmentManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: PhoneControlApi,
    private val secureStore: SecureStore,
    private val configuration: ConfigurationDao,
    private val syncEngine: SyncEngine,
    private val lockScheduler: LockScheduler,
    private val kiosk: KioskController,
    private val json: Json,
) {

    sealed interface Result {
        data class Success(val assetTag: String, val depotName: String?) : Result
        data class Failure(val message: String) : Result
    }

    suspend fun enroll(enrollmentToken: String, serverUrl: String?): Result {
        if (!secureStore.isAvailable) {
            return Result.Failure(
                "Magasin sécurisé indisponible sur ce terminal. " +
                    "Réinitialisez l'appareil avant de le provisionner.",
            )
        }

        serverUrl?.takeIf { it.isNotBlank() }?.let { url ->
            // L'URL est enregistrée AVANT l'appel : Retrofit la lit à la
            // construction, un changement ultérieur ne serait pris en compte
            // qu'au prochain démarrage.
            secureStore.serverUrl = if (url.endsWith("/")) url else "$url/"
        }

        val response = runCatching {
            api.enroll(
                EnrollRequest(
                    enrollmentToken = enrollmentToken.trim(),
                    manufacturer = Build.MANUFACTURER,
                    model = Build.MODEL,
                    serialNumber = runCatching { Build.getSerial() }.getOrNull(),
                    androidVersion = Build.VERSION.RELEASE,
                    appVersion = BuildConfig.VERSION_NAME,
                    // Déclaratif et vérifié : le serveur affichera « Device
                    // Owner non confirmé » tant que ce n'est pas vrai.
                    deviceOwnerActive = kiosk.isDeviceOwner,
                ),
            )
        }.getOrElse { error ->
            Log.e(TAG, "Enrôlement impossible : ${error.message}")
            return Result.Failure("Serveur injoignable. Vérifiez l'adresse et le réseau.")
        }

        if (!response.isSuccessful) {
            return Result.Failure(
                when (response.code()) {
                    401 -> "Jeton d'enrôlement invalide, expiré ou déjà utilisé."
                    else -> "Enrôlement refusé (code ${response.code()})."
                },
            )
        }

        val body = response.body()
            ?: return Result.Failure("Réponse d'enrôlement invalide.")

        secureStore.deviceId = body.deviceId
        secureStore.assetTag = body.assetTag
        secureStore.accessToken = body.accessToken
        secureStore.refreshToken = body.refreshToken

        // La clé HMAC entre dans le Keystore et n'en ressortira plus : c'est
        // elle qui rend la liste hors ligne inutilisable sur un autre appareil.
        runCatching { secureStore.storeOfflineKey(body.offlineKey) }
            .onFailure { Log.e(TAG, "Clé hors ligne non stockée : ${it.message}") }

        body.settings?.let { configuration.upsertSettings(it.toEntity(json)) }

        body.depot?.let { depot ->
            configuration.upsertDepot(
                DepotEntity(
                    id = depot.id,
                    name = depot.name,
                    latitude = depot.latitude,
                    longitude = depot.longitude,
                    radiusMeters = depot.radiusMeters,
                    exitHysteresisMeters = depot.exitHysteresisMeters,
                    timezone = depot.timezone,
                    returnTime = depot.returnTime,
                    lockTime = depot.lockTime,
                    operationalDayStart = depot.operationalDayStart,
                    scheduleOverridesJson = depot.scheduleOverrides?.toString(),
                    wifiHintsJson = depot.wifiHints?.toString(),
                ),
            )
        }

        // Première synchronisation complète : elle rapporte la liste hors ligne
        // et les commandes en attente. Sans elle, le téléphone serait enrôlé
        // mais incapable de fonctionner sans réseau.
        runCatching { syncEngine.synchronize() }
            .onFailure { Log.w(TAG, "Première synchronisation incomplète : ${it.message}") }

        lockScheduler.schedule()
        SyncWorker.schedule(context)

        if (!kiosk.isDeviceOwner) {
            Log.w(
                TAG,
                "Enrôlé SANS Device Owner : le mode kiosque n'est pas garanti " +
                    "sur ce terminal tant qu'il n'a pas été provisionné.",
            )
        }

        return Result.Success(body.assetTag, body.depot?.name)
    }

    private companion object {
        const val TAG = "EnrollmentManager"
    }
}
