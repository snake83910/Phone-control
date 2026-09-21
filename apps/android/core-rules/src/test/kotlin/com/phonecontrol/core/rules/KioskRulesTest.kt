package com.phonecontrol.core.rules

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * La porte de sortie du scanner.
 *
 * Panne constatee sur le terminal : verrouille, on ne sortait pas de
 * l'application — mais un appui sur SCANNER, sans aucun badge presente, et le
 * telephone redevenait libre. Le kiosque suivait l'ecran, et l'ecran de scan
 * n'etait pas l'ecran de verrouillage.
 *
 * Ce fichier fixe l'invariant : on ne sort du kiosque qu'en s'identifiant.
 */
class KioskRulesTest {

    @Test
    fun `le scanner tient le kiosque autant que l ecran de verrouillage`() {
        assertTrue("verrouille", shouldEnforceKiosk(AppScreen.LOCK))
        assertTrue("scan en cours", shouldEnforceKiosk(AppScreen.SCANNER))
    }

    @Test
    fun `une session ouverte rend le telephone`() {
        // C'est tout l'objet du produit : badge, le chauffeur s'en sert.
        assertFalse(shouldEnforceKiosk(AppScreen.ACTIVE))
    }

    @Test
    fun `un appareil pas encore rattache n est pas enferme`() {
        // Rien a proteger, personne a identifier — et l'enfermer avant sa mise
        // en service le rendrait inutilisable.
        assertFalse(shouldEnforceKiosk(AppScreen.ENROLLMENT))
    }

    /**
     * L'invariant qui compte, exprime sur la machine a etats plutot que sur
     * l'ecran : tout ce qu'on atteint sans `AccessGranted` reste verrouille.
     *
     * Si quelqu'un ouvrait un jour `ScanRequested` depuis un autre etat que
     * `LOCKED`, ce test tomberait — et c'est voulu : la regle du kiosque
     * repose entierement sur cette restriction.
     */
    @Test
    fun `on n atteint le scanner que depuis le verrouillage`() {
        val depuisVerrouille = DeviceStateMachine.reduce(
            DeviceContext(state = DeviceState.LOCKED),
            DeviceEvent.ScanRequested,
        )
        assertEquals(DeviceState.SCANNING, depuisVerrouille.context.state)

        for (etat in DeviceState.entries.filter { it != DeviceState.LOCKED }) {
            val r = DeviceStateMachine.reduce(
                DeviceContext(state = etat),
                DeviceEvent.ScanRequested,
            )
            assertEquals("$etat ne doit pas ouvrir le scanner", etat, r.context.state)
        }
    }

    @Test
    fun `renoncer au scan ramene au verrouillage, sans jamais l avoir leve`() {
        val scan = DeviceStateMachine.reduce(
            DeviceContext(state = DeviceState.LOCKED),
            DeviceEvent.ScanRequested,
        )
        assertTrue(shouldEnforceKiosk(AppScreen.SCANNER))
        assertFalse(
            "aucun ExitKiosk ne doit sortir d'une demande de scan",
            scan.effects.any { it is DeviceEffect.ExitKiosk },
        )

        val annule = DeviceStateMachine.reduce(scan.context, DeviceEvent.ScanCancelled)
        assertEquals(DeviceState.LOCKED, annule.context.state)
        assertFalse(annule.effects.any { it is DeviceEffect.ExitKiosk })
    }

    @Test
    fun `un badge refuse ne rend pas le telephone`() {
        val scan = DeviceStateMachine.reduce(
            DeviceContext(state = DeviceState.LOCKED),
            DeviceEvent.ScanRequested,
        )
        val lu = DeviceStateMachine.reduce(
            scan.context,
            DeviceEvent.BarcodeCaptured("0123456789"),
        )
        assertEquals(DeviceState.AUTHENTICATING, lu.context.state)
        assertFalse(lu.effects.any { it is DeviceEffect.ExitKiosk })

        val refus = DeviceStateMachine.reduce(
            lu.context,
            DeviceEvent.AccessDenied("unknown_badge", "Badge inconnu"),
        )
        assertEquals(DeviceState.LOCKED, refus.context.state)
        assertFalse(refus.effects.any { it is DeviceEffect.ExitKiosk })
    }

    @Test
    fun `seul un acces accorde leve le kiosque`() {
        val scan = DeviceStateMachine.reduce(
            DeviceContext(state = DeviceState.LOCKED),
            DeviceEvent.ScanRequested,
        )
        val lu = DeviceStateMachine.reduce(
            scan.context,
            DeviceEvent.BarcodeCaptured("0123456789"),
        )
        val accorde = DeviceStateMachine.reduce(
            lu.context,
            DeviceEvent.AccessGranted(
                sessionId = "s1",
                userId = "u1",
                expiresAt = Instant.parse("2026-09-21T18:00:00Z"),
            ),
        )
        assertEquals(DeviceState.ACTIVE, accorde.context.state)
        assertTrue(accorde.effects.any { it is DeviceEffect.ExitKiosk })
        assertFalse(shouldEnforceKiosk(AppScreen.ACTIVE))
    }
}
