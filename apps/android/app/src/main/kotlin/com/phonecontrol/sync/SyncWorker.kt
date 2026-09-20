package com.phonecontrol.sync

import android.content.Context
import android.os.BatteryManager
import android.util.Log
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.remote.HeartbeatRequest
import com.phonecontrol.data.remote.PhoneControlApi
import com.phonecontrol.kiosk.KioskController
import com.phonecontrol.security.IntegrityMonitor
import com.phonecontrol.security.SecureStore
import com.phonecontrol.session.SessionManager
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Synchronisation périodique et signal de vie.
 *
 * Le repli exponentiel de WorkManager est complété par un **jitter** : sans lui,
 * un millier de téléphones reprenant le réseau après une coupure de secteur
 * frapperaient l'API à la même seconde. C'est la cause classique d'un
 * effondrement au retour de service, et elle se prévient ici, pas côté serveur.
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted private val context: Context,
    @Assisted params: WorkerParameters,
    private val syncEngine: SyncEngine,
    private val api: PhoneControlApi,
    private val secureStore: SecureStore,
    private val sessionManager: SessionManager,
    private val kiosk: KioskController,
    private val configuration: ConfigurationDao,
    private val integrity: IntegrityMonitor,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!secureStore.isEnrolled) {
            // Rien à synchroniser tant que l'appareil n'est pas enrôlé : ce
            // n'est pas un échec, c'est un état.
            return Result.success()
        }

        // Petite attente aléatoire : étale les reprises simultanées.
        kotlinx.coroutines.delay(Random.nextLong(0, JITTER_MS))

        // L'état du terminal est examiné AVANT l'envoi : un constat fait
        // maintenant part dans le même lot, plutôt que d'attendre le cycle
        // suivant. En cas d'échec, la synchronisation continue — la surveillance
        // d'intégrité ne doit jamais empêcher la remontée du reste.
        runCatching { integrity.check() }.onFailure {
            Log.w(TAG, "Contrôle d'intégrité impossible : ${it.message}")
        }

        val heartbeat = runCatching { sendHeartbeat() }
        if (heartbeat.isFailure) {
            Log.w(TAG, "Heartbeat impossible : ${heartbeat.exceptionOrNull()?.message}")
        }

        val outcome = syncEngine.synchronize()

        val executed = runCatching {
            syncEngine.executeCommands { reason ->
                sessionManager.lock(reason)
                // Depuis le travail de fond, l'interface n'existe peut-être
                // pas — et si elle existe, elle est derrière l'application que
                // le chauffeur utilise. `startLockTask()` exigeant le premier
                // plan, verrouiller sans ramener l'écran devant ne verrouille
                // rien du tout : l'état change, le téléphone reste utilisable.
                kiosk.ramenerAuPremierPlan()
            }
        }.getOrDefault(0)

        Log.i(
            TAG,
            "Synchronisation : ${outcome.pushed} envoyé(s), ${outcome.acked} acquitté(s), " +
                "${outcome.commandsReceived} commande(s), $executed exécutée(s).",
        )

        // `retry` seulement en cas d'échec réseau : une erreur métier ne se
        // corrige pas en réessayant, et remplirait la file de travaux.
        return if (outcome.success) Result.success() else Result.retry()
    }

    private suspend fun sendHeartbeat() {
        val deviceId = secureStore.deviceId ?: return
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager

        api.heartbeat(
            HeartbeatRequest(
                deviceId = deviceId,
                battery = batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY),
                charging = batteryManager?.isCharging,
                network = networkType(),
                gps = isLocationEnabled(),
                appVersion = com.phonecontrol.BuildConfig.VERSION_NAME,
                androidVersion = android.os.Build.VERSION.RELEASE,
                // Jamais supposé : c'est le système qui répond.
                deviceOwnerActive = kiosk.isDeviceOwner,
                // `null` quand Firebase est absent — construction sans
                // `google-services.json`, ou services Play défaillants. Le
                // serveur garde alors le dernier jeton connu et le réveil
                // reste au sondage.
                fcmToken = jetonDeReveil(context),
            ),
        )
    }

    private fun networkType(): String {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? android.net.ConnectivityManager ?: return "unknown"
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
            ?: return "none"
        return when {
            capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            else -> "other"
        }
    }

    private fun isLocationEnabled(): Boolean {
        val manager = context.getSystemService(Context.LOCATION_SERVICE)
            as? android.location.LocationManager ?: return false
        return manager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER)
    }

    companion object {
        private const val TAG = "SyncWorker"
        private const val JITTER_MS = 20_000L

        private const val PERIODIC_NAME = "phone-control-sync"
        private const val IMMEDIATE_NAME = "phone-control-sync-now"
        private const val LOCK_CHECK_NAME = "phone-control-lock-check"

        /**
         * Planification par défaut.
         *
         * Quinze minutes est le plancher imposé par WorkManager pour un travail
         * périodique ; c'est aussi l'intervalle documenté en docs/05 §5.
         */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val periodic = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                // KEEP : ne pas réinitialiser le cycle à chaque démarrage de
                // l'application, sinon la synchronisation n'arriverait jamais
                // sur un téléphone souvent redémarré.
                ExistingPeriodicWorkPolicy.KEEP,
                periodic,
            )

            val lockCheck = PeriodicWorkRequestBuilder<
                com.phonecontrol.schedule.LockCheckWorker,
                >(15, TimeUnit.MINUTES).build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                LOCK_CHECK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                lockCheck,
            )
        }

        /** Synchronisation immédiate : ouverture de session, retour du réseau. */
        fun syncNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_NAME,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }
    }
}
