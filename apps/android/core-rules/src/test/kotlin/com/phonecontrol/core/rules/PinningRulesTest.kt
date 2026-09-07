package com.phonecontrol.core.rules

import java.io.File
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Politique d'épinglage.
 *
 * Les cas vivent dans `packages/state-machine-spec/scenarios/pinning.json` :
 * une règle qui peut couper une flotte entière mérite d'être relisible sans
 * ouvrir de code.
 */
class PinningRulesTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val spec by lazy {
        val dir = File(
            System.getProperty("scenarios.dir")
                ?: error("Propriété système scenarios.dir absente."),
        )
        json.parseToJsonElement(File(dir, "pinning.json").readText()).jsonObject
    }

    @Test
    fun `politiques conformes aux scenarios`() {
        val now = Instant.parse(spec["now"]!!.jsonPrimitive.content)
        var executed = 0

        for (entry in spec["scenarios"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content
            val expected = scenario["expect"]!!.jsonObject

            val verdict = evaluatePinningPolicy(policyOf(scenario), now)

            assertEquals(
                "$name : statut",
                expected["status"]!!.jsonPrimitive.content,
                verdict.status.name,
            )
            assertEquals(
                "$name : empreintes appliquées",
                expected["activePins"]!!.jsonPrimitive.content.toInt(),
                verdict.activePins.size,
            )
            expected["renewalDue"]?.let {
                assertEquals(
                    "$name : rotation à préparer",
                    it.jsonPrimitive.content.toBoolean(),
                    verdict.renewalDue,
                )
            }
            assertTrue("$name : un verdict doit toujours s'expliquer", verdict.reason != null)
            executed++
        }

        assertTrue("Aucun scénario exécuté", executed > 0)
    }

    @Test
    fun `le delai de preavis est celui des scenarios`() {
        assertEquals(
            spec["renewalWarningDays"]!!.jsonPrimitive.long,
            PINNING_RENEWAL_WARNING_DAYS,
        )
    }

    @Test
    fun `aucune politique ne produit jamais d echec de connexion`() {
        // La propriété la plus importante de ce module : quelle que soit
        // l'entrée, on n'obtient jamais « refuser la connexion ». Au pire
        // l'épinglage n'est pas appliqué, et le défaut est signalé.
        val now = Instant.parse("2026-09-05T12:00:00Z")
        val absurdes = listOf(
            null,
            PinningPolicy("", emptyList(), null),
            PinningPolicy("api.exemple.fr", listOf("x"), now),
            PinningPolicy("api.exemple.fr", listOf("A".repeat(43) + "="), now.minusSeconds(1)),
        )

        for (policy in absurdes) {
            val verdict = evaluatePinningPolicy(policy, now)
            assertTrue(
                "Statut inattendu pour $policy",
                verdict.status in setOf(
                    PinningStatus.ABSENT,
                    PinningStatus.REJECTED,
                    PinningStatus.EXPIRED,
                ),
            )
            assertTrue("Aucune empreinte ne doit être appliquée", verdict.activePins.isEmpty())
        }
    }

    @Test
    fun `une politique valable applique exactement ses empreintes`() {
        val pins = listOf("A".repeat(43) + "=", "B".repeat(43) + "=")
        val verdict = evaluatePinningPolicy(
            PinningPolicy("api.exemple.fr", pins, Instant.parse("2027-01-01T00:00:00Z")),
            Instant.parse("2026-09-05T12:00:00Z"),
        )

        assertEquals(PinningStatus.ACTIVE, verdict.status)
        assertEquals(pins, verdict.activePins)
        assertFalse(verdict.renewalDue)
    }

    private fun policyOf(scenario: kotlinx.serialization.json.JsonObject): PinningPolicy? {
        val node = scenario["policy"]
        if (node == null || node is JsonNull) return null

        val policy = node.jsonObject
        val expires = policy["expiresAt"]
        return PinningPolicy(
            host = policy["host"]!!.jsonPrimitive.content,
            pins = policy["pins"]!!.jsonArray.map { it.jsonPrimitive.content },
            expiresAt = if (expires == null || expires is JsonNull) {
                null
            } else {
                Instant.parse(expires.jsonPrimitive.content)
            },
        )
    }
}
