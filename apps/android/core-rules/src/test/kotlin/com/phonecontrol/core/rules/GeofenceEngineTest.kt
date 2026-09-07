package com.phonecontrol.core.rules

import java.io.File
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Moteur de geofencing local.
 *
 * Ces scénarios n'ont pas d'équivalent côté serveur : le serveur reçoit des
 * transitions déjà confirmées. Ils vivent tout de même dans
 * `packages/state-machine-spec` pour que les règles anti-faux-positifs soient
 * relisibles au même endroit que le reste de la logique métier.
 */
class GeofenceEngineTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val scenariosDir = File(
        System.getProperty("scenarios.dir")
            ?: error("Propriété système scenarios.dir absente."),
    )

    /** Un mètre de latitude, pour placer un point à une distance donnée du dépôt. */
    private val metersPerDegreeLatitude = 111_320.0

    @Test
    fun `moteur local conforme aux scenarios`() {
        val spec = json
            .parseToJsonElement(File(scenariosDir, "geofence-engine.json").readText())
            .jsonObject

        val depot = spec["depot"]!!.jsonObject
        val config = GeofenceConfig(
            latitude = depot["latitude"]!!.jsonPrimitive.double,
            longitude = depot["longitude"]!!.jsonPrimitive.double,
            radiusMeters = depot["radiusMeters"]!!.jsonPrimitive.double,
            hysteresisMeters = depot["hysteresisMeters"]!!.jsonPrimitive.double,
            accuracyThresholdMeters = depot["accuracyThresholdMeters"]!!.jsonPrimitive.double,
            confirmationSamples = depot["confirmationSamples"]!!.jsonPrimitive.content.toInt(),
            confirmationSeconds = depot["confirmationSeconds"]!!.jsonPrimitive.content.toLong(),
            maxSpeedMps = depot["maxSpeedMps"]!!.jsonPrimitive.double,
        )

        var executed = 0

        for (entry in spec["scenarios"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content
            val engine = GeofenceEngine(
                config,
                ZoneState.valueOf(scenario["initialState"]!!.jsonPrimitive.content),
            )

            for (fixEntry in scenario["fixes"]!!.jsonArray) {
                val step = fixEntry.jsonObject
                val outcome = engine.accept(fixOf(step, config))

                assertEquals(
                    "$name — état après ${step["t"]!!.jsonPrimitive.content}",
                    step["expectState"]!!.jsonPrimitive.content,
                    outcome.state.name,
                )

                val expectedRejection = step["expectRejected"]?.jsonPrimitive?.content
                assertEquals(
                    "$name — motif de rejet",
                    expectedRejection,
                    outcome.rejected?.name,
                )

                val expectedTransition = step["expectTransition"]
                if (expectedTransition == null ||
                    expectedTransition is kotlinx.serialization.json.JsonNull
                ) {
                    assertNull("$name — aucune transition attendue", outcome.transition)
                } else {
                    assertNotNull("$name — une transition était attendue", outcome.transition)
                    assertEquals(
                        "$name — sens de la transition",
                        expectedTransition.jsonPrimitive.content,
                        outcome.transition!!.kind.name,
                    )

                    step["expectTransitionAt"]?.jsonPrimitive?.content?.let { expectedAt ->
                        // La transition est datée de la PREMIÈRE mesure cohérente :
                        // le chauffeur est entré quand il est entré, pas deux
                        // minutes plus tard quand le moteur a fini de conclure.
                        assertEquals(
                            "$name — horodatage de la transition",
                            Instant.parse(expectedAt),
                            outcome.transition.occurredAt,
                        )
                    }

                    assertTrue(
                        "$name — la confiance doit être renseignée",
                        outcome.transition.confidence in 0.0..1.0,
                    )
                    assertTrue(
                        "$name — les mesures ayant conduit à la décision doivent être conservées",
                        outcome.transition.evaluation.isNotEmpty(),
                    )
                }

                executed++
            }
        }

        assertTrue("Aucune mesure exécutée", executed > 0)
    }

    @Test
    fun `une mesure ecartee reste signalee a l appelant`() {
        val config = GeofenceConfig(latitude = 43.296482, longitude = 5.36978)
        val engine = GeofenceEngine(config, ZoneState.INSIDE)

        val outcome = engine.accept(
            LocationFix(
                recordedAt = Instant.parse("2026-09-07T18:00:00Z"),
                latitude = 48.8566,
                longitude = 2.3522,
                accuracyMeters = 5.0,
                isMock = true,
            ),
        )

        // Écartée de la DÉCISION, mais l'appelant doit pouvoir la remonter :
        // une position simulée est un signal de fraude, jamais un silence.
        assertEquals(RejectionReason.MOCK, outcome.rejected)
        assertNull(outcome.transition)
        assertEquals(ZoneState.INSIDE, outcome.state)
    }

    @Test
    fun `la confiance diminue quand la marge se rapproche de l incertitude`() {
        val config = GeofenceConfig(
            latitude = 43.296482,
            longitude = 5.36978,
            confirmationSamples = 3,
            confirmationSeconds = 120,
        )

        val franche = runExit(config, distance = 2000.0, accuracy = 10.0)
        val limite = runExit(config, distance = 380.0, accuracy = 45.0)

        assertNotNull(franche)
        assertNotNull(limite)
        assertTrue(
            "Une sortie franche doit inspirer plus de confiance qu'une sortie limite",
            franche!!.confidence > limite!!.confidence,
        )
    }

    private fun runExit(
        config: GeofenceConfig,
        distance: Double,
        accuracy: Double,
    ): ConfirmedTransition? {
        val engine = GeofenceEngine(config, ZoneState.INSIDE)
        var last: ConfirmedTransition? = null
        var seconds = 0L
        repeat(3) {
            val outcome = engine.accept(
                LocationFix(
                    recordedAt = Instant.parse("2026-09-07T19:00:00Z").plusSeconds(seconds),
                    latitude = config.latitude + distance / metersPerDegreeLatitude,
                    longitude = config.longitude,
                    accuracyMeters = accuracy,
                ),
            )
            last = outcome.transition ?: last
            seconds += 90
        }
        return last
    }

    private fun fixOf(step: JsonObject, config: GeofenceConfig): LocationFix {
        val distance = step["distance"]!!.jsonPrimitive.double
        return LocationFix(
            recordedAt = Instant.parse(step["t"]!!.jsonPrimitive.content),
            latitude = config.latitude + distance / metersPerDegreeLatitude,
            longitude = config.longitude,
            accuracyMeters = step["accuracy"]!!.jsonPrimitive.double,
            isMock = step["isMock"]?.jsonPrimitive?.boolean ?: false,
            wifiSuggestsDepot = step["wifiSuggestsDepot"]?.jsonPrimitive?.boolean ?: false,
            deviceIsStill = step["deviceIsStill"]?.jsonPrimitive?.boolean ?: false,
        )
    }
}
