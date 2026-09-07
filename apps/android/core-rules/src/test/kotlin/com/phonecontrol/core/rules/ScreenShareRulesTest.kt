package com.phonecontrol.core.rules

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Machine à états du partage d'écran, côté téléphone.
 *
 * Les mêmes scénarios sont exécutés par le serveur
 * (`apps/api/src/screen-share/rules.spec.ts`). C'est le seul dispositif qui
 * empêche les deux implémentations de diverger — et une divergence signifierait
 * un téléphone qui capture dans un état que le serveur refuse, c'est-à-dire un
 * écran parti sans que personne ne sache le dire.
 */
class ScreenShareRulesTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val spec by lazy {
        val dir = File(
            System.getProperty("scenarios.dir")
                ?: error("Propriété système scenarios.dir absente."),
        )
        json.parseToJsonElement(File(dir, "screen-share.json").readText()).jsonObject
    }

    private val expiresAt = 1_760_000_000_000L

    @Test
    fun `transitions conformes aux scenarios`() {
        var executed = 0

        for (entry in spec["transitions"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content

            val result = transitionScreenShare(
                ScreenShareState.valueOf(scenario["from"]!!.jsonPrimitive.content),
                ScreenShareEvent.valueOf(scenario["event"]!!.jsonPrimitive.content),
            )

            assertEquals(
                "$name : état obtenu",
                ScreenShareState.valueOf(scenario["to"]!!.jsonPrimitive.content),
                result.state,
            )
            assertEquals(
                "$name : événement retenu",
                scenario["applied"]!!.jsonPrimitive.boolean,
                result.applied,
            )
            executed++
        }

        assertTrue("Aucun scénario exécuté : le fichier est-il bien lu ?", executed >= 14)
    }

    @Test
    fun `capture conforme aux scenarios`() {
        for (entry in spec["frames"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content

            assertEquals(
                name,
                scenario["accepted"]!!.jsonPrimitive.boolean,
                shouldCapture(
                    state = ScreenShareState.valueOf(scenario["state"]!!.jsonPrimitive.content),
                    expiresAtMillis = expiresAt,
                    nowMillis = expiresAt + scenario["nowOffsetMs"]!!.jsonPrimitive.long,
                ),
            )
        }
    }

    @Test
    fun `affichage de la demande conforme aux scenarios`() {
        for (entry in spec["prompt"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content

            assertEquals(
                name,
                scenario["show"]!!.jsonPrimitive.boolean,
                shouldPromptDriver(
                    state = ScreenShareState.valueOf(scenario["state"]!!.jsonPrimitive.content),
                    expiresAtMillis = expiresAt,
                    nowMillis = expiresAt + scenario["nowOffsetMs"]!!.jsonPrimitive.long,
                ),
            )
        }
    }

    /**
     * Le téléphone doit s'arrêter tout seul. Un appareil qui perd le réseau
     * juste après l'accord ne recevra jamais l'ordre de fin : si la limite ne
     * tenait que côté serveur, il capturerait indéfiniment.
     */
    @Test
    fun `le telephone cesse de capturer a l echeance, sans qu on le lui dise`() {
        assertTrue(shouldCapture(ScreenShareState.ACCEPTED, expiresAt, expiresAt - 1))
        assertFalse(shouldCapture(ScreenShareState.ACCEPTED, expiresAt, expiresAt))
        assertFalse(shouldCapture(ScreenShareState.ACCEPTED, expiresAt, expiresAt + 1))
    }

    @Test
    fun `aucun etat terminal ne se rouvre`() {
        val terminaux = ScreenShareState.entries.filter { it.isTerminal }
        assertEquals(5, terminaux.size)

        for (state in terminaux) {
            for (event in ScreenShareEvent.entries) {
                val result = transitionScreenShare(state, event)
                assertEquals("$state + $event", state, result.state)
                assertFalse("$state + $event", result.applied)
            }
        }
    }

    /**
     * Le masquage d'écran est le point où deux exigences se contredisent :
     * protéger le numéro de badge affiché, et pouvoir montrer l'application à
     * quelqu'un qui aide. Ces quatre cas fixent l'arbitrage.
     */
    @Test
    fun `l ecran de scan reste masque meme pendant un partage`() {
        assertTrue(shouldMaskScreen(AppScreen.SCANNER, sharing = true))
        assertTrue(shouldMaskScreen(AppScreen.SCANNER, sharing = false))
    }

    @Test
    fun `les autres ecrans se montrent pendant un partage, et pas autrement`() {
        for (screen in listOf(AppScreen.LOCK, AppScreen.ACTIVE, AppScreen.ENROLLMENT)) {
            assertFalse("$screen pendant un partage", shouldMaskScreen(screen, sharing = true))
            assertTrue("$screen hors partage", shouldMaskScreen(screen, sharing = false))
        }
    }

    @Test
    fun `hors partage, tout est masque`() {
        // Le comportement par défaut ne change pas : c'est la propriété qui
        // rend l'arbitrage acceptable.
        for (screen in AppScreen.entries) {
            assertTrue(shouldMaskScreen(screen, sharing = false))
        }
    }
}
