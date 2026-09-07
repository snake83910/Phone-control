package com.phonecontrol.core.rules

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Machine à états du téléphone.
 *
 * Écrits en Kotlin plutôt qu'en scénarios JSON partagés : cette machine n'a pas
 * d'équivalent côté serveur, et ce qui compte ici autant que l'état résultant,
 * ce sont les EFFETS déclarés (caméra, kiosque, suivi de position). Un format
 * de données les rendrait moins lisibles qu'un test qui les nomme.
 */
class DeviceStateMachineTest {

    private val schedule = DepotSchedule(
        timezone = "Europe/Paris",
        returnTime = "18:00",
        lockTime = "22:00",
    )

    private fun locked() = DeviceContext()

    private fun granted(context: DeviceContext = locked()): DeviceContext =
        DeviceStateMachine.reduce(
            DeviceStateMachine.reduce(
                DeviceStateMachine.reduce(context, DeviceEvent.ScanRequested).context,
                DeviceEvent.BarcodeCaptured("14557719"),
            ).context,
            DeviceEvent.AccessGranted(
                sessionId = "session-1",
                userId = "user-1",
                expiresAt = Instant.parse("2026-09-08T04:00:00Z"),
            ),
        ).context

    // -----------------------------------------------------------------------

    @Test
    fun `parcours nominal du verrouillage a la session active`() {
        var context = locked()
        assertEquals(DeviceState.LOCKED, context.state)

        val scan = DeviceStateMachine.reduce(context, DeviceEvent.ScanRequested)
        assertEquals(DeviceState.SCANNING, scan.context.state)
        assertTrue(scan.effects.contains(DeviceEffect.StartCamera))

        val captured = DeviceStateMachine.reduce(
            scan.context,
            DeviceEvent.BarcodeCaptured("14557719"),
        )
        assertEquals(DeviceState.AUTHENTICATING, captured.context.state)
        assertTrue(captured.effects.contains(DeviceEffect.StopCamera))
        // Retour haptique à la lecture : le chauffeur doit savoir que le code a
        // été capté sans avoir à lire l'écran.
        assertTrue(captured.effects.contains(DeviceEffect.Vibrate(success = true)))

        val active = DeviceStateMachine.reduce(
            captured.context,
            DeviceEvent.AccessGranted(
                sessionId = "session-1",
                userId = "user-1",
                expiresAt = Instant.parse("2026-09-08T04:00:00Z"),
            ),
        )
        context = active.context
        assertEquals(DeviceState.ACTIVE, context.state)
        assertEquals("session-1", context.session?.sessionId)
        assertTrue(active.effects.contains(DeviceEffect.ExitKiosk))
        // Le suivi de position ne démarre QU'ICI : hors session, aucune donnée
        // de localisation n'est collectée (exigence RGPD).
        assertTrue(active.effects.contains(DeviceEffect.StartLocationTracking))
    }

    @Test
    fun `un refus ramene au verrouillage avec un message`() {
        val scanning = DeviceStateMachine.reduce(locked(), DeviceEvent.ScanRequested).context
        val captured = DeviceStateMachine.reduce(
            scanning,
            DeviceEvent.BarcodeCaptured("99999999"),
        ).context

        val denied = DeviceStateMachine.reduce(
            captured,
            DeviceEvent.AccessDenied(
                reason = "DEVICE_NOT_AUTHORIZED",
                message = "Ce téléphone n'est pas autorisé pour cet utilisateur.",
            ),
        )

        assertEquals(DeviceState.LOCKED, denied.context.state)
        assertEquals(
            "Ce téléphone n'est pas autorisé pour cet utilisateur.",
            denied.context.notice,
        )
        assertNull(denied.context.session)
        assertTrue(denied.effects.contains(DeviceEffect.Vibrate(success = false)))
    }

    @Test
    fun `entree au depot apres l heure de retour fait passer a RETURNED`() {
        val active = granted()
        val occurredAt = Instant.parse("2026-09-07T16:15:00Z") // 18h15 à Paris

        val decision = evaluateGeofenceTransition(
            TransitionKind.ENTER,
            occurredAt,
            schedule,
            SessionState.ACTIVE,
        )
        val result = DeviceStateMachine.reduce(
            active,
            DeviceEvent.GeofenceConfirmed(decision, occurredAt),
        )

        assertEquals(DeviceState.RETURNED, result.context.state)
        assertEquals(occurredAt, result.context.session?.returnedAt)
        assertTrue(
            result.effects.any { it is DeviceEffect.ReportGeofence },
        )
    }

    @Test
    fun `sortie apres retour signale une alerte sans bloquer le telephone`() {
        var context = granted()
        val entry = Instant.parse("2026-09-07T16:17:00Z")
        context = DeviceStateMachine.reduce(
            context,
            DeviceEvent.GeofenceConfirmed(
                evaluateGeofenceTransition(TransitionKind.ENTER, entry, schedule, SessionState.ACTIVE),
                entry,
            ),
        ).context
        assertEquals(DeviceState.RETURNED, context.state)

        val exit = Instant.parse("2026-09-07T17:42:00Z")
        val decision = evaluateGeofenceTransition(
            TransitionKind.EXIT,
            exit,
            schedule,
            SessionState.RETURNED,
        )
        val result = DeviceStateMachine.reduce(context, DeviceEvent.GeofenceConfirmed(decision, exit))

        assertNotNull("Une alerte devait être décidée", decision.alert)
        assertTrue("L'alerte doit être signalée", result.context.alertPending)
        // Le téléphone reste utilisable : l'alerte n'est pas un état bloquant.
        assertEquals(DeviceState.ACTIVE, result.context.state)
        assertNotNull("La session reste ouverte", result.context.session)
        // L'horodatage du premier retour n'est pas effacé.
        assertEquals(entry, result.context.session?.returnedAt)
    }

    @Test
    fun `le verrouillage arrete le suivi de position et entre en kiosque`() {
        val active = granted()

        val locking = DeviceStateMachine.reduce(
            active,
            DeviceEvent.LockRequested(LockReason.SCHEDULED_LOCAL),
        )
        assertEquals(DeviceState.LOCKING, locking.context.state)
        assertTrue(locking.effects.contains(DeviceEffect.StopLocationTracking))
        assertTrue(
            locking.effects.contains(DeviceEffect.EnterKiosk(LockReason.SCHEDULED_LOCAL)),
        )

        val locked = DeviceStateMachine.reduce(locking.context, DeviceEvent.LockApplied)
        assertEquals(DeviceState.LOCKED, locked.context.state)
        // La session disparaît de l'état local : plus aucun porteur identifié.
        assertNull(locked.context.session)
        assertFalse(locked.context.alertPending)
    }

    @Test
    fun `verrouiller un telephone deja verrouille est sans effet`() {
        val result = DeviceStateMachine.reduce(
            locked(),
            DeviceEvent.LockRequested(LockReason.SERVER_COMMAND),
        )

        // Idempotence : le serveur peut réémettre l'ordre sans conséquence.
        assertEquals(DeviceState.LOCKED, result.context.state)
        assertTrue(result.effects.isEmpty())
    }

    @Test
    fun `l expiration de session verrouille le telephone`() {
        val result = DeviceStateMachine.reduce(granted(), DeviceEvent.SessionExpired)

        assertEquals(DeviceState.LOCKING, result.context.state)
        assertTrue(result.effects.contains(DeviceEffect.EnterKiosk(LockReason.EXPIRED)))
        assertTrue(result.effects.contains(DeviceEffect.StopLocationTracking))
    }

    @Test
    fun `une transition de geofence sans session est remontee sans changer d etat`() {
        val decision = evaluateGeofenceTransition(
            TransitionKind.ENTER,
            Instant.parse("2026-09-07T16:15:00Z"),
            schedule,
            SessionState.ACTIVE,
        )
        val result = DeviceStateMachine.reduce(
            locked(),
            DeviceEvent.GeofenceConfirmed(decision, Instant.parse("2026-09-07T16:15:00Z")),
        )

        assertEquals(DeviceState.LOCKED, result.context.state)
        // Elle est tout de même transmise : le serveur en fera ce qu'il veut.
        assertTrue(result.effects.any { it is DeviceEffect.ReportGeofence })
    }

    @Test
    fun `une session ouverte hors ligne est marquee comme telle`() {
        val result = DeviceStateMachine.reduce(
            DeviceStateMachine.reduce(locked(), DeviceEvent.ScanRequested).context,
            DeviceEvent.AccessGranted(
                sessionId = "session-offline",
                userId = "user-1",
                expiresAt = Instant.parse("2026-09-08T02:00:00Z"),
                offline = true,
            ),
        )

        // Le marqueur suit la session jusqu'à sa revalidation par le serveur.
        assertTrue(result.context.session!!.openedOffline)
    }
}
