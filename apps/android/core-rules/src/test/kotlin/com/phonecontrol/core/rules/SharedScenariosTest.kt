package com.phonecontrol.core.rules

import java.io.File
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exécution des scénarios de référence partagés.
 *
 * **Ces fichiers sont les mêmes que ceux exécutés par Jest côté serveur**
 * (`apps/api/src/rules/scenarios.spec.ts`). Le moteur existe en deux
 * implémentations parce qu'il doit fonctionner hors ligne sur le téléphone tout
 * en restant sous l'autorité du serveur ; sans ce jeu de cas commun, les deux
 * finiraient par diverger sans que personne ne s'en aperçoive.
 *
 * Si un test échoue ici et passe côté serveur, ce n'est pas le test qui est
 * faux : c'est que les deux implémentations ne disent plus la même chose.
 */
class SharedScenariosTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val scenariosDir: File = File(
        System.getProperty("scenarios.dir")
            ?: error("Propriété système scenarios.dir absente (voir build.gradle.kts)."),
    )

    private fun load(name: String): JsonObject =
        json.parseToJsonElement(File(scenariosDir, name).readText()).jsonObject

    // -----------------------------------------------------------------------
    //  Classification géométrique
    // -----------------------------------------------------------------------

    @Test
    fun `classification geometrique conforme aux scenarios partages`() {
        val spec = load("geofence-classification.json")
        var executed = 0

        for (entry in spec["cases"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content

            val actual = classifyFix(
                distanceMeters = case["distanceMeters"]!!.jsonPrimitive.double,
                accuracyMeters = case["accuracyMeters"]!!.jsonPrimitive.double,
                radiusMeters = case["radiusMeters"]!!.jsonPrimitive.double,
                hysteresisMeters = case["hysteresisMeters"]!!.jsonPrimitive.double,
            )

            assertEquals(name, case["expect"]!!.jsonPrimitive.content, actual.name)
            executed++
        }

        assertTrue("Aucun cas exécuté : le fichier de scénarios est-il vide ?", executed > 0)
    }

    @Test
    fun `distances haversine conformes aux scenarios partages`() {
        val spec = load("geofence-classification.json")

        for (entry in spec["distances"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val from = case["from"]!!.jsonObject
            val to = case["to"]!!.jsonObject

            val meters = haversineMeters(
                from["latitude"]!!.jsonPrimitive.double,
                from["longitude"]!!.jsonPrimitive.double,
                to["latitude"]!!.jsonPrimitive.double,
                to["longitude"]!!.jsonPrimitive.double,
            )

            val expected = case["expectMeters"]!!.jsonPrimitive.double
            val tolerance = case["toleranceMeters"]!!.jsonPrimitive.double
            assertEquals(name, expected, meters, tolerance)
        }
    }

    // -----------------------------------------------------------------------
    //  Règles du dépôt
    // -----------------------------------------------------------------------

    @Test
    fun `regles du depot conformes aux scenarios partages`() {
        val spec = load("depot-rules.json")
        val base = spec["depot"]!!.jsonObject
        var executed = 0

        for (entry in spec["scenarios"]!!.jsonArray) {
            val scenario = entry.jsonObject
            val name = scenario["name"]!!.jsonPrimitive.content

            val schedule = DepotSchedule(
                timezone = base["timezone"]!!.jsonPrimitive.content,
                returnTime = base["returnTime"]!!.jsonPrimitive.content,
                lockTime = base["lockTime"]!!.jsonPrimitive.content,
                operationalDayStart = base["operationalDayStart"]!!.jsonPrimitive.content,
                overrides = ScheduleOverridesJson.parse(scenario["depotOverrides"]),
            )

            var state = SessionState.valueOf(scenario["initialState"]!!.jsonPrimitive.content)

            for (stepEntry in scenario["steps"]!!.jsonArray) {
                val step = stepEntry.jsonObject
                val expected = step["expect"]!!.jsonObject

                val decision = evaluateGeofenceTransition(
                    transition = TransitionKind.valueOf(step["transition"]!!.jsonPrimitive.content),
                    occurredAt = Instant.parse(normalizeInstant(step["at"]!!.jsonPrimitive.content)),
                    schedule = schedule,
                    sessionState = state,
                )

                assertEquals(
                    "$name — type d'événement",
                    expected["eventType"]!!.jsonPrimitive.content,
                    decision.eventType.name,
                )
                assertEquals(
                    "$name — état de session",
                    expected["sessionState"]!!.jsonPrimitive.content,
                    decision.nextSessionState.name,
                )
                assertEquals(
                    "$name — marquage du retour",
                    expected["markReturned"]!!.jsonPrimitive.boolean,
                    decision.markReturned,
                )
                assertEquals(
                    "$name — alerte",
                    expected["alert"].asNullableString(),
                    decision.alert?.type,
                )

                state = decision.nextSessionState
                executed++
            }
        }

        assertTrue(executed > 0)
    }

    // -----------------------------------------------------------------------
    //  Règles horaires
    // -----------------------------------------------------------------------

    @Test
    fun `jour operationnel conforme aux scenarios partages`() {
        val spec = load("schedule.json")
        val schedule = baseSchedule(spec)

        for (entry in spec["operationalDay"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val instant = Instant.parse(normalizeInstant(case["at"]!!.jsonPrimitive.content))
            assertEquals(name, case["expect"]!!.jsonPrimitive.content, schedule.operationalDayOf(instant))
        }
    }

    @Test
    fun `prochain verrouillage conforme aux scenarios partages`() {
        val spec = load("schedule.json")

        for (entry in spec["nextLock"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content

            val schedule = baseSchedule(spec).copy(
                lockTime = case["lockTime"]?.jsonPrimitive?.content
                    ?: baseSchedule(spec).lockTime,
                overrides = ScheduleOverridesJson.parse(case["overrides"]),
            )

            val from = Instant.parse(normalizeInstant(case["from"]!!.jsonPrimitive.content))
            val actual = schedule.nextLockInstant(from)

            assertNotNull("$name — un verrouillage était attendu", actual)
            assertEquals(
                name,
                Instant.parse(case["expectUtc"]!!.jsonPrimitive.content),
                actual,
            )
        }
    }

    @Test
    fun `regles du jour conformes aux scenarios partages`() {
        val spec = load("schedule.json")

        for (entry in spec["dayRules"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val schedule = baseSchedule(spec).copy(
                overrides = ScheduleOverridesJson.parse(case["overrides"]),
            )
            val expected = case["expect"]!!.jsonObject
            val rules = schedule.resolveDayRules(case["date"]!!.jsonPrimitive.content)

            assertEquals("$name — retour", expected["returnTime"].asNullableString(), rules.returnTime)
            assertEquals("$name — verrouillage", expected["lockTime"].asNullableString(), rules.lockTime)
        }
    }

    @Test
    fun `changements d heure conformes aux scenarios partages`() {
        val spec = load("schedule.json")

        for (entry in spec["dstEdgeCases"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val schedule = baseSchedule(spec).copy(
                operationalDayStart = case["operationalDayStart"]!!.jsonPrimitive.content,
            )

            val instant = schedule.instantForLocalTime(
                case["date"]!!.jsonPrimitive.content,
                case["localTime"]!!.jsonPrimitive.content,
            )

            val expected = case["expectUtc"]?.jsonPrimitive?.content
            if (expected != null) {
                assertEquals(name, Instant.parse(expected), instant)
            } else {
                // Le cas « 02h30 n'existe pas » : l'important est qu'aucune
                // exception ne soit levée et qu'un instant valide soit produit.
                assertNotNull(name, instant)
            }
        }
    }

    @Test
    fun `fuseaux horaires conformes aux scenarios partages`() {
        val spec = load("schedule.json")

        for (entry in spec["timezones"]!!.jsonArray) {
            val case = entry.jsonObject
            val name = case["name"]!!.jsonPrimitive.content
            val schedule = baseSchedule(spec).copy(
                timezone = case["timezone"]!!.jsonPrimitive.content,
            )

            val instant = schedule.instantForLocalTime(
                case["date"]!!.jsonPrimitive.content,
                case["localTime"]!!.jsonPrimitive.content,
            )

            assertEquals(name, Instant.parse(case["expectUtc"]!!.jsonPrimitive.content), instant)
        }
    }

    // -----------------------------------------------------------------------

    private fun baseSchedule(spec: JsonObject): DepotSchedule {
        val depot = spec["depot"]!!.jsonObject
        return DepotSchedule(
            timezone = depot["timezone"]!!.jsonPrimitive.content,
            returnTime = depot["returnTime"]!!.jsonPrimitive.content,
            lockTime = depot["lockTime"]!!.jsonPrimitive.content,
            operationalDayStart = depot["operationalDayStart"]!!.jsonPrimitive.content,
        )
    }

    /** `Instant.parse` n'accepte que le suffixe Z : on convertit les décalages. */
    private fun normalizeInstant(value: String): String =
        java.time.OffsetDateTime.parse(value).toInstant().toString()

    private fun kotlinx.serialization.json.JsonElement?.asNullableString(): String? =
        when {
            this == null -> null
            this is JsonNull -> null
            this is JsonArray -> null
            else -> jsonPrimitive.content
        }
}
