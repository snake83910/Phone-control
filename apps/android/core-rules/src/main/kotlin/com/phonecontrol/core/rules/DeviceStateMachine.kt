package com.phonecontrol.core.rules

import java.time.Instant

/**
 * Machine à états du téléphone (section 55 de la spécification).
 *
 * Fonction pure, sans Android : elle se teste en millisecondes et se raisonne
 * sans émulateur. L'interface Compose se contente d'afficher [DeviceState] et
 * d'émettre des [DeviceEvent] ; c'est ce découplage qui rend la logique
 * vérifiable.
 *
 * Point de conception : `ALERT` n'est PAS un état.
 * Un téléphone en alerte reste `ACTIVE` ou `RETURNED` — l'alerte est un fait
 * signalé au serveur, pas un mode de fonctionnement. En faire un état bloquant
 * rendrait ingérable le cas, fréquent, du chauffeur légitimement reparti.
 */

enum class DeviceState {
    /** Écran « Présentez votre badge ». Aucune utilisation possible. */
    LOCKED,

    /** Caméra active, en attente d'un Code 128. */
    SCANNING,

    /** Code lu, vérification en cours (serveur ou cache hors ligne). */
    AUTHENTICATING,

    /** Session ouverte, téléphone utilisable. */
    ACTIVE,

    /** Rentré au dépôt après l'heure de retour. Le téléphone reste utilisable. */
    RETURNED,

    /** Verrouillage ordonné, exécution en cours. */
    LOCKING,
}

sealed interface DeviceEvent {
    /** L'utilisateur demande le scanner. */
    data object ScanRequested : DeviceEvent

    /** L'utilisateur abandonne le scan. */
    data object ScanCancelled : DeviceEvent

    /** Un code a été lu : vérification lancée. */
    data class BarcodeCaptured(val normalizedValue: String) : DeviceEvent

    /** Le serveur — ou le cache hors ligne — a accordé l'accès. */
    data class AccessGranted(
        val sessionId: String,
        val userId: String,
        val expiresAt: Instant,
        val offline: Boolean = false,
    ) : DeviceEvent

    /** Accès refusé. Le motif est affiché, puis l'écran revient au verrouillage. */
    data class AccessDenied(val reason: String, val message: String) : DeviceEvent

    /** Transition de geofence confirmée par le moteur local. */
    data class GeofenceConfirmed(
        val decision: GeofenceDecision,
        val occurredAt: Instant,
    ) : DeviceEvent

    /** Heure de verrouillage atteinte, ou commande serveur reçue. */
    data class LockRequested(val reason: LockReason) : DeviceEvent

    /** Le verrouillage a été appliqué par le système. */
    data object LockApplied : DeviceEvent

    /** La session a atteint sa durée maximale. */
    data object SessionExpired : DeviceEvent
}

enum class LockReason {
    /** Heure de verrouillage du dépôt, décidée localement. */
    SCHEDULED_LOCAL,

    /** Commande LOCK_DEVICE reçue du serveur. */
    SERVER_COMMAND,

    /** Session révoquée par un administrateur ou après revalidation. */
    REVOKED,

    /** Durée maximale de session dépassée. */
    EXPIRED,
}

data class SessionSnapshot(
    val sessionId: String,
    val userId: String,
    val expiresAt: Instant,
    val openedOffline: Boolean,
    val returnedAt: Instant? = null,
)

data class DeviceContext(
    val state: DeviceState = DeviceState.LOCKED,
    val session: SessionSnapshot? = null,
    /** Dernier message à afficher (refus, information). */
    val notice: String? = null,
    /** Une alerte est en cours de remontée. Superposé, jamais bloquant. */
    val alertPending: Boolean = false,
)

/**
 * Effets à exécuter par la couche Android. La machine ne les exécute pas :
 * elle les décrit. C'est ce qui permet de la tester sans le système.
 */
sealed interface DeviceEffect {
    data object StartCamera : DeviceEffect
    data object StopCamera : DeviceEffect
    data object StartLocationTracking : DeviceEffect
    data object StopLocationTracking : DeviceEffect
    data class EnterKiosk(val reason: LockReason?) : DeviceEffect
    data object ExitKiosk : DeviceEffect
    data class ReportGeofence(val decision: GeofenceDecision, val occurredAt: Instant) : DeviceEffect
    data class Vibrate(val success: Boolean) : DeviceEffect
}

data class Reduction(
    val context: DeviceContext,
    val effects: List<DeviceEffect> = emptyList(),
)

object DeviceStateMachine {

    fun reduce(context: DeviceContext, event: DeviceEvent): Reduction = when (event) {
        DeviceEvent.ScanRequested ->
            if (context.state == DeviceState.LOCKED) {
                Reduction(
                    context.copy(state = DeviceState.SCANNING, notice = null),
                    listOf(DeviceEffect.StartCamera),
                )
            } else {
                Reduction(context)
            }

        DeviceEvent.ScanCancelled ->
            if (context.state == DeviceState.SCANNING) {
                Reduction(
                    context.copy(state = DeviceState.LOCKED),
                    listOf(DeviceEffect.StopCamera),
                )
            } else {
                Reduction(context)
            }

        is DeviceEvent.BarcodeCaptured ->
            if (context.state == DeviceState.SCANNING) {
                Reduction(
                    context.copy(state = DeviceState.AUTHENTICATING),
                    listOf(DeviceEffect.StopCamera, DeviceEffect.Vibrate(success = true)),
                )
            } else {
                Reduction(context)
            }

        is DeviceEvent.AccessGranted -> {
            val session = SessionSnapshot(
                sessionId = event.sessionId,
                userId = event.userId,
                expiresAt = event.expiresAt,
                openedOffline = event.offline,
            )
            Reduction(
                DeviceContext(state = DeviceState.ACTIVE, session = session),
                listOf(
                    DeviceEffect.ExitKiosk,
                    // Le suivi ne démarre qu'ici : hors session, aucune position
                    // n'est collectée (exigence RGPD, docs/07 §6).
                    DeviceEffect.StartLocationTracking,
                ),
            )
        }

        is DeviceEvent.AccessDenied ->
            Reduction(
                context.copy(state = DeviceState.LOCKED, notice = event.message),
                listOf(DeviceEffect.StopCamera, DeviceEffect.Vibrate(success = false)),
            )

        is DeviceEvent.GeofenceConfirmed -> {
            if (context.session == null) {
                // Sans session, une transition n'a pas de sens métier : elle est
                // tout de même remontée, le serveur en fera ce qu'il veut.
                Reduction(
                    context,
                    listOf(DeviceEffect.ReportGeofence(event.decision, event.occurredAt)),
                )
            } else {
                val returned = event.decision.nextSessionState == SessionState.RETURNED
                Reduction(
                    context.copy(
                        state = if (returned) DeviceState.RETURNED else DeviceState.ACTIVE,
                        session = context.session.copy(
                            returnedAt = when {
                                event.decision.markReturned -> event.occurredAt
                                else -> context.session.returnedAt
                            },
                        ),
                        alertPending = context.alertPending || event.decision.alert != null,
                    ),
                    listOf(DeviceEffect.ReportGeofence(event.decision, event.occurredAt)),
                )
            }
        }

        is DeviceEvent.LockRequested ->
            if (context.state == DeviceState.LOCKED) {
                Reduction(context)
            } else {
                Reduction(
                    context.copy(state = DeviceState.LOCKING),
                    listOf(
                        DeviceEffect.StopLocationTracking,
                        DeviceEffect.EnterKiosk(event.reason),
                    ),
                )
            }

        DeviceEvent.SessionExpired ->
            Reduction(
                context.copy(state = DeviceState.LOCKING),
                listOf(
                    DeviceEffect.StopLocationTracking,
                    DeviceEffect.EnterKiosk(LockReason.EXPIRED),
                ),
            )

        DeviceEvent.LockApplied ->
            Reduction(
                DeviceContext(state = DeviceState.LOCKED, notice = context.notice),
                listOf(DeviceEffect.StopCamera),
            )
    }
}
