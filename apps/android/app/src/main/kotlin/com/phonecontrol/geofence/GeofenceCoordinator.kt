package com.phonecontrol.geofence

import android.util.Log
import com.phonecontrol.core.rules.DepotSchedule
import com.phonecontrol.core.rules.DeviceEvent
import com.phonecontrol.core.rules.GeofenceConfig
import com.phonecontrol.core.rules.GeofenceEngine
import com.phonecontrol.core.rules.LocationFix
import com.phonecontrol.core.rules.RejectionReason
import com.phonecontrol.core.rules.ScheduleOverridesJson
import com.phonecontrol.core.rules.SessionState
import com.phonecontrol.core.rules.TransitionKind
import com.phonecontrol.core.rules.ZoneState
import com.phonecontrol.core.rules.evaluateGeofenceTransition
import com.phonecontrol.data.local.ConfigurationDao
import com.phonecontrol.data.local.DepotEntity
import com.phonecontrol.session.SessionManager
import com.phonecontrol.sync.EventRecorder
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

/**
 * Passerelle entre le flux de positions et le moteur de règles.
 *
 * Elle ne décide rien elle-même : le moteur ([GeofenceEngine]) dit s'il y a
 * transition, les règles ([evaluateGeofenceTransition]) disent ce que cela
 * signifie. Ce découpage est ce qui permet de tester la logique sans Android,
 * et de la faire correspondre exactement à celle du serveur.
 *
 * Toute mesure est enregistrée, **y compris celle qui est écartée** : une
 * position simulée ou une précision aberrante sont des signaux, pas des
 * silences.
 */
@Singleton
class GeofenceCoordinator @Inject constructor(
    private val configuration: ConfigurationDao,
    private val sessionManager: SessionManager,
    private val recorder: EventRecorder,
    private val json: Json,
) {

    private val mutex = Mutex()
    private var engine: GeofenceEngine? = null
    private var engineDepotId: String? = null

    suspend fun onLocation(fix: LocationFix) = mutex.withLock {
        val depot = configuration.depot()
        val sessionId = sessionManager.context.value.session?.sessionId

        if (depot == null) {
            // Sans dépôt, aucune zone à surveiller : la position est tout de
            // même remontée, elle alimente la carte du dashboard.
            recorder.recordLocation(fix, sessionId, insideGeofence = null)
            return@withLock
        }

        val engine = engineFor(depot)
        val outcome = engine.accept(fix)

        recorder.recordLocation(
            fix = fix,
            sessionId = sessionId,
            insideGeofence = when (outcome.state) {
                ZoneState.INSIDE, ZoneState.EXIT_PENDING -> true
                ZoneState.OUTSIDE, ZoneState.ENTER_PENDING -> false
            },
        )

        when (outcome.rejected) {
            RejectionReason.MOCK -> recorder.recordSecurity(
                type = "MOCK_LOCATION",
                severity = "HIGH",
                metadata = mapOf("latitude" to fix.latitude.toString()),
                sessionId = sessionId,
            )
            RejectionReason.SPEED_JUMP -> Log.w(TAG, "Saut de position écarté.")
            RejectionReason.ACCURACY, RejectionReason.STALE -> Unit
            null -> Unit
        }

        val transition = outcome.transition ?: return@withLock

        val schedule = depot.toSchedule()
        val sessionState =
            if (sessionManager.context.value.session?.returnedAt != null) SessionState.RETURNED
            else SessionState.ACTIVE

        val decision = evaluateGeofenceTransition(
            transition = transition.kind,
            occurredAt = transition.occurredAt,
            schedule = schedule,
            sessionState = sessionState,
        )

        Log.i(
            TAG,
            "Transition ${transition.kind} confirmée (confiance " +
                "${"%.2f".format(transition.confidence)}) -> ${decision.eventType}",
        )

        recorder.recordGeofence(transition, decision, depot.id, sessionId)
        sessionManager.dispatch(
            DeviceEvent.GeofenceConfirmed(decision, transition.occurredAt),
        )
    }

    /**
     * Le moteur est reconstruit si la configuration du dépôt change : un rayon
     * corrigé depuis le dashboard doit s'appliquer sans redémarrer l'application.
     */
    private suspend fun engineFor(depot: DepotEntity): GeofenceEngine {
        if (engine != null && engineDepotId == depot.id) return engine!!

        val settings = configuration.settings()
        val created = GeofenceEngine(
            GeofenceConfig(
                latitude = depot.latitude,
                longitude = depot.longitude,
                radiusMeters = depot.radiusMeters.toDouble(),
                hysteresisMeters = depot.exitHysteresisMeters.toDouble(),
                accuracyThresholdMeters =
                    (settings?.gpsAccuracyThresholdMeters ?: 100).toDouble(),
                confirmationSamples = settings?.geofenceConfirmationSamples ?: 3,
                confirmationSeconds = (settings?.geofenceConfirmationSeconds ?: 120).toLong(),
            ),
            // Un téléphone qui redémarre au dépôt repartira de OUTSIDE et
            // reconfirmera son entrée : trois mesures de retard valent mieux
            // qu'un état supposé.
            initialState = ZoneState.OUTSIDE,
        )

        engine = created
        engineDepotId = depot.id
        return created
    }

    private fun DepotEntity.toSchedule(): DepotSchedule = DepotSchedule(
        timezone = timezone,
        returnTime = returnTime,
        lockTime = lockTime,
        operationalDayStart = operationalDayStart,
        overrides = scheduleOverridesJson?.let {
            ScheduleOverridesJson.parse(json.parseToJsonElement(it))
        },
    )

    /** Vitesse de rafraîchissement souhaitée : plus dense près du dépôt. */
    suspend fun isNearDepot(fix: LocationFix): Boolean {
        val depot = configuration.depot() ?: return false
        val distance = com.phonecontrol.core.rules.haversineMeters(
            depot.latitude,
            depot.longitude,
            fix.latitude,
            fix.longitude,
        )
        return distance < NEAR_DEPOT_METERS
    }

    private companion object {
        const val TAG = "GeofenceCoordinator"

        /**
         * En deçà, l'échantillonnage se resserre. C'est ce qui rend la détection
         * d'entrée fiable sans interroger le GPS en continu toute la journée.
         */
        const val NEAR_DEPOT_METERS = 1_000.0
    }
}
