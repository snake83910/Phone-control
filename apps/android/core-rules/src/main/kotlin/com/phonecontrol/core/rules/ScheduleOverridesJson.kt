package com.phonecontrol.core.rules

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Lecture des surcharges horaires transmises par le serveur.
 *
 * Le champ `scheduleOverrides` est du JSON libre côté API : un type figé le
 * rendrait impossible à faire évoluer sans migration ni nouvelle version de
 * l'application. Il est donc analysé ici, à la main.
 *
 * Subtilité qui justifie l'existence de ce fichier : il faut distinguer
 * « champ absent » (on garde la valeur du dépôt) de « valeur nulle » (aucune
 * règle ce jour-là). Une désérialisation naïve confondrait les deux et
 * ferait disparaître le verrouillage du samedi.
 */
object ScheduleOverridesJson {

    fun parse(element: JsonElement?): ScheduleOverrides? {
        if (element == null || element is JsonNull) return null
        val root = element as? JsonObject ?: return null

        val weekdays = (root["weekdays"] as? JsonObject)
            ?.mapValues { (_, value) -> parseDayOverride(value) }
            ?: emptyMap()

        val holidays = (root["holidays"] as? JsonElement)
            ?.takeIf { it !is JsonNull }
            ?.jsonArray
            ?.mapNotNull { entry ->
                val obj = entry as? JsonObject ?: return@mapNotNull null
                val date = obj["date"]?.jsonPrimitive?.contentOrNullSafe()
                    ?: return@mapNotNull null
                // Absent OU explicitement nul : aucune règle ce jour-là.
                val rules = if (!obj.containsKey("rules")) null
                else parseDayOverride(obj["rules"])
                HolidayOverride(date = date, rules = rules)
            }
            ?: emptyList()

        val special = (root["special"] as? JsonElement)
            ?.takeIf { it !is JsonNull }
            ?.jsonArray
            ?.mapNotNull { entry ->
                val obj = entry as? JsonObject ?: return@mapNotNull null
                val from = obj["from"]?.jsonPrimitive?.contentOrNullSafe()
                    ?: return@mapNotNull null
                val to = obj["to"]?.jsonPrimitive?.contentOrNullSafe()
                    ?: return@mapNotNull null
                SpecialPeriod(
                    from = from,
                    to = to,
                    returnTime = obj["returnTime"]?.asNullableString(),
                    hasReturnTime = obj.containsKey("returnTime"),
                    lockTime = obj["lockTime"]?.asNullableString(),
                    hasLockTime = obj.containsKey("lockTime"),
                )
            }
            ?: emptyList()

        return ScheduleOverrides(weekdays = weekdays, holidays = holidays, special = special)
    }

    private fun parseDayOverride(element: JsonElement?): DayOverride? {
        if (element == null || element is JsonNull) return null
        val obj = element as? JsonObject ?: return null
        return DayOverride(
            returnTime = obj["returnTime"]?.asNullableString(),
            hasReturnTime = obj.containsKey("returnTime"),
            lockTime = obj["lockTime"]?.asNullableString(),
            hasLockTime = obj.containsKey("lockTime"),
        )
    }

    private fun JsonElement.asNullableString(): String? =
        if (this is JsonNull) null else (this as? JsonPrimitive)?.contentOrNullSafe()

    private fun JsonPrimitive.contentOrNullSafe(): String? =
        if (this is JsonNull) null else content
}
