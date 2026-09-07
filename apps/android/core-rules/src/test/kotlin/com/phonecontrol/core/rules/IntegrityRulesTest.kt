package com.phonecontrol.core.rules

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Politique d'intégrité du terminal.
 *
 * Les cas vivent dans `packages/state-machine-spec/scenarios/integrity.json`.
 * Comme pour le moteur de geofencing, ils n'ont pas d'équivalent côté serveur :
 * ils sont là pour que la politique se relise comme une donnée, et pour qu'une
 * modification de sévérité soit un changement visible plutôt qu'une ligne
 * perdue dans une expression conditionnelle.
 */
class IntegrityRulesTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val spec by lazy {
        val dir = File(
            System.getProperty("scenarios.dir")
                ?: error("Propriété système scenarios.dir absente."),
        )
        json.parseToJsonElement(File(dir, "integrity.json").readText()).jsonObject
    }

    @Test
    fun `qualification conforme aux scenarios`() {
        var executed = 0

        for (entry in spec["scenarios"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content

            val observations = evaluateIntegrity(signalsOf(scenario["signals"]!!.jsonObject))
            val expected = scenario["expect"]!!.jsonArray.map { it.jsonObject }

            assertEquals(
                "$name : nombre de constats",
                expected.size,
                observations.size,
            )

            expected.forEachIndexed { index, expectation ->
                val observation = observations[index]
                assertEquals(
                    "$name : constat ${index + 1}",
                    expectation["finding"]!!.jsonPrimitive.content,
                    observation.eventType,
                )
                assertEquals(
                    "$name : sévérité du constat ${index + 1}",
                    expectation["severity"]!!.jsonPrimitive.content,
                    observation.severity,
                )
                assertTrue(
                    "$name : un constat doit toujours porter ses indices",
                    observation.evidence.isNotEmpty(),
                )
            }
            executed++
        }

        assertTrue("Aucun scénario exécuté", executed > 0)
    }

    @Test
    fun `cadence des remontees conforme aux scenarios`() {
        val repeatAfter = spec["repeatAfterMillis"]!!.jsonPrimitive.long
        var executed = 0

        for (entry in spec["cadence"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content

            val observations = scenario["observed"]!!.jsonArray.map {
                IntegrityObservation(
                    IntegrityFinding.valueOf(it.jsonPrimitive.content),
                    listOf("indice de test"),
                )
            }
            val state = IntegrityState(
                scenario["reportedAtMillis"]!!.jsonObject.entries.associate { (key, value) ->
                    IntegrityFinding.valueOf(key) to value.jsonPrimitive.long
                },
            )

            val report = planIntegrityReports(
                observations,
                state,
                scenario["nowMillis"]!!.jsonPrimitive.long,
                repeatAfter,
            )

            assertEquals(
                "$name : constats émis",
                scenario["emit"]!!.jsonArray.map { it.jsonPrimitive.content },
                report.toEmit.map { it.eventType },
            )
            assertEquals(
                "$name : état conservé",
                scenario["stateAfter"]!!.jsonObject.entries.associate { (key, value) ->
                    IntegrityFinding.valueOf(key) to value.jsonPrimitive.long
                },
                report.state.reportedAtMillis,
            )
            executed++
        }

        assertTrue("Aucun scénario de cadence exécuté", executed > 0)
    }

    @Test
    fun `la periode de repetition par defaut est celle des scenarios`() {
        assertEquals(
            spec["repeatAfterMillis"]!!.jsonPrimitive.long,
            INTEGRITY_REPEAT_AFTER_MILLIS,
        )
    }

    @Test
    fun `une compilation debug enrichit le constat sans en creer un nouveau`() {
        val observations = evaluateIntegrity(
            IntegritySignals(debuggerAttached = true, debuggableBuild = true),
        )

        assertEquals(1, observations.size)
        assertTrue(
            observations.first().evidence.any { it.contains("debug") },
        )
    }

    @Test
    fun `une signature non verifiable ne vaut pas une signature fausse`() {
        // Confondre les deux produirait une alerte CRITICAL après un simple
        // incident de lecture, et apprendrait à l'exploitation à les ignorer.
        assertTrue(evaluateIntegrity(IntegritySignals(signatureMatchesExpected = null)).isEmpty())
        assertEquals(
            listOf(IntegrityFinding.APP_INTEGRITY_FAILED),
            evaluateIntegrity(IntegritySignals(signatureMatchesExpected = false))
                .map { it.finding },
        )
    }

    private fun signalsOf(node: JsonObject): IntegritySignals {
        fun strings(key: String): List<String> =
            node[key]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()

        fun flag(key: String): Boolean = node[key]?.jsonPrimitive?.boolean ?: false

        val signature = node["signatureMatchesExpected"]
        return IntegritySignals(
            suBinariesFound = strings("suBinariesFound"),
            rootPackagesFound = strings("rootPackagesFound"),
            buildTags = node["buildTags"]?.jsonPrimitive?.content,
            debuggerAttached = flag("debuggerAttached"),
            debuggableBuild = flag("debuggableBuild"),
            adbEnabled = flag("adbEnabled"),
            developerOptionsEnabled = flag("developerOptionsEnabled"),
            signatureMatchesExpected =
                if (signature == null || signature is JsonNull) null
                else signature.jsonPrimitive.boolean,
        )
    }
}
