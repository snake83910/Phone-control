package com.phonecontrol.core.rules

import java.time.Instant
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Décisions métier sur une transition de geofence.
 *
 * Portage fidèle de `apps/api/src/rules/geofence-rules.ts`, contraint par les
 * mêmes scénarios (`packages/state-machine-spec/scenarios/depot-rules.json`).
 *
 * Le téléphone applique ces règles pour réagir immédiatement, y compris hors
 * ligne. Le serveur les réapplique à la réception et **fait autorité** : c'est
 * lui qui détient l'heure de référence et la configuration à jour du dépôt.
 */

enum class TransitionKind { ENTER, EXIT }

enum class GeofenceEventType {
    ENTER_DEPOT,
    EXIT_DEPOT,
    ENTER_DEPOT_AFTER_RETURN_TIME,
    AFTER_RETURN_EXIT,
}

enum class SessionState { ACTIVE, RETURNED }

data class GeofenceAlert(
    val type: String = "AFTER_RETURN_EXIT",
    val severity: String = "HIGH",
    val title: String = "Sortie du dépôt après le retour",
)

data class GeofenceDecision(
    val eventType: GeofenceEventType,
    val nextSessionState: SessionState,
    /** Faut-il marquer le retour (horodatage et position) ? */
    val markReturned: Boolean,
    val alert: GeofenceAlert?,
    /** Explication lisible, conservée dans l'événement pour le support. */
    val reason: String,
)

fun evaluateGeofenceTransition(
    transition: TransitionKind,
    occurredAt: Instant,
    schedule: DepotSchedule,
    sessionState: SessionState,
): GeofenceDecision {
    if (transition == TransitionKind.ENTER) {
        if (!schedule.isAfterReturnTime(occurredAt)) {
            // Passage au dépôt en cours de tournée : ce n'est pas une fin de journée.
            return GeofenceDecision(
                eventType = GeofenceEventType.ENTER_DEPOT,
                nextSessionState = sessionState,
                markReturned = false,
                alert = null,
                reason = "Entrée au dépôt avant l'heure de retour : aucun effet.",
            )
        }

        return GeofenceDecision(
            eventType = GeofenceEventType.ENTER_DEPOT_AFTER_RETURN_TIME,
            nextSessionState = SessionState.RETURNED,
            // L'horodatage de retour n'est pas réécrit si la session est déjà
            // marquée retournée : le premier retour fait foi.
            markReturned = sessionState != SessionState.RETURNED,
            alert = null,
            reason = "Entrée au dépôt après l'heure de retour : téléphone considéré comme retourné.",
        )
    }

    if (sessionState == SessionState.RETURNED) {
        return GeofenceDecision(
            eventType = GeofenceEventType.AFTER_RETURN_EXIT,
            // L'alerte n'est pas un état bloquant : la session redevient active
            // et l'alerte reste ouverte jusqu'à acquittement (docs/02 §6).
            nextSessionState = SessionState.ACTIVE,
            markReturned = false,
            alert = GeofenceAlert(),
            reason = "Sortie du dépôt alors que le téléphone était marqué comme retourné.",
        )
    }

    return GeofenceDecision(
        eventType = GeofenceEventType.EXIT_DEPOT,
        nextSessionState = sessionState,
        markReturned = false,
        alert = null,
        reason = "Sortie du dépôt en cours de tournée : aucun effet.",
    )
}

// ---------------------------------------------------------------------------
//  Classification géométrique
// ---------------------------------------------------------------------------

enum class FixClassification { INSIDE_CERTAIN, OUTSIDE_CERTAIN, UNDETERMINED }

private const val EARTH_RADIUS_M = 6_371_008.8

/** Distance haversine, en mètres. */
fun haversineMeters(
    lat1: Double,
    lon1: Double,
    lat2: Double,
    lon2: Double,
): Double {
    val toRad = { degrees: Double -> degrees * PI / 180.0 }
    val dLat = toRad(lat2 - lat1)
    val dLon = toRad(lon2 - lon1)
    val a = sin(dLat / 2).let { it * it } +
        cos(toRad(lat1)) * cos(toRad(lat2)) * sin(dLon / 2).let { it * it }
    return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
}

/**
 * Classe un point par rapport à une zone, en tenant compte de son incertitude.
 *
 *   d + a  <  R        -> certainement dedans
 *   d - a  >  R + H    -> certainement dehors
 *   sinon              -> indéterminé, AUCUNE transition
 *
 * C'est cette troisième branche qui absorbe le faux positif décrit dans la
 * spécification : 50 m hors zone avec 100 m de précision reste indéterminé.
 */
fun classifyFix(
    distanceMeters: Double,
    accuracyMeters: Double,
    radiusMeters: Double,
    hysteresisMeters: Double,
): FixClassification = when {
    distanceMeters + accuracyMeters < radiusMeters -> FixClassification.INSIDE_CERTAIN
    distanceMeters - accuracyMeters > radiusMeters + hysteresisMeters ->
        FixClassification.OUTSIDE_CERTAIN
    else -> FixClassification.UNDETERMINED
}
