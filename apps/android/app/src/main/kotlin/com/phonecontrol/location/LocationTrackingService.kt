package com.phonecontrol.location

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.phonecontrol.MainActivity
import com.phonecontrol.R
import com.phonecontrol.core.rules.LocationFix
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.geofence.GeofenceCoordinator
import dagger.hilt.android.AndroidEntryPoint
import java.time.Instant
import javax.inject.Inject
import kotlinx.coroutines.launch

/**
 * Suivi de position pendant une session active.
 *
 * **Il ne démarre qu'avec une session, et s'arrête avec elle.** Ce n'est pas
 * une optimisation de batterie mais une exigence : la CNIL interdit le suivi des
 * salariés en dehors du temps de travail. Hors session, ce service n'existe pas.
 *
 * Android 14 impose qu'un tel service soit de premier plan, typé `location`, et
 * affiche une notification permanente. C'est aussi ce qui rend le dispositif
 * visible du chauffeur : il ne peut pas être suivi sans le voir.
 *
 * Le rythme d'échantillonnage s'adapte : resserré à l'approche du dépôt, où la
 * décision se joue ; relâché en tournée, où seule la trace importe.
 */
@AndroidEntryPoint
class LocationTrackingService : LifecycleService() {

    @Inject lateinit var coordinator: GeofenceCoordinator
    @Inject lateinit var configuration: ConfigurationDao

    private lateinit var client: FusedLocationProviderClient
    private var currentIntervalMs: Long = DEFAULT_INTERVAL_MS

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation ?: return
            lifecycleScope.launch { handle(location) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        client = LocationServices.getFusedLocationProviderClient(this)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (!hasLocationPermission()) {
            // Sans la permission, on s'arrête plutôt que de tourner à vide :
            // une notification de suivi sans suivi serait un mensonge.
            Log.e(TAG, "Permission de localisation absente : service arrêté.")
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification())
        requestUpdates(DEFAULT_INTERVAL_MS)

        // START_STICKY : si le système tue le service, il le relance. C'est le
        // minimum face aux gestionnaires de batterie des constructeurs — sans
        // garantir quoi que ce soit, ce qui est documenté en docs/01 §2.3.
        return START_STICKY
    }

    override fun onDestroy() {
        client.removeLocationUpdates(callback)
        super.onDestroy()
    }

    private suspend fun handle(location: Location) {
        val fix = LocationFix(
            recordedAt = Instant.ofEpochMilli(location.time),
            latitude = location.latitude,
            longitude = location.longitude,
            accuracyMeters = location.accuracy.toDouble(),
            isMock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                location.isMock
            } else {
                @Suppress("DEPRECATION")
                location.isFromMockProvider
            },
            speedMps = location.speed.toDouble(),
        )

        coordinator.onLocation(fix)

        // Cadence adaptative : la décision d'entrée se joue près du dépôt, pas
        // au milieu d'une tournée.
        val settings = configuration.settings()
        val near = coordinator.isNearDepot(fix)
        val desired = when {
            near -> NEAR_DEPOT_INTERVAL_MS
            else -> (settings?.locationIntervalActiveSeconds ?: 60).toLong() * 1_000
        }

        if (desired != currentIntervalMs) {
            requestUpdates(desired)
        }
    }

    private fun requestUpdates(intervalMs: Long) {
        if (!hasLocationPermission()) return
        currentIntervalMs = intervalMs

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            // Marge haute : le système peut regrouper les réveils, ce qui
            // économise nettement la batterie sans nuire à la décision.
            .setMaxUpdateDelayMillis(intervalMs * 2)
            .build()

        client.removeLocationUpdates(callback)
        runCatching {
            client.requestLocationUpdates(request, callback, Looper.getMainLooper())
        }.onFailure { Log.e(TAG, "Demande de position refusée : ${it.message}") }
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.location_channel_name),
            // LOW : la notification doit être visible, pas sonore.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.location_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.location_notification_title))
            .setContentText(getString(R.string.location_notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(intent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    companion object {
        private const val TAG = "LocationTracking"
        private const val CHANNEL_ID = "phone_control_location"
        private const val NOTIFICATION_ID = 4201

        private const val DEFAULT_INTERVAL_MS = 60_000L
        private const val NEAR_DEPOT_INTERVAL_MS = 20_000L

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, LocationTrackingService::class.java),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocationTrackingService::class.java))
        }
    }
}
