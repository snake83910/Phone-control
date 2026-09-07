package com.phonecontrol.core.rules

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Résolution des règles horaires d'un dépôt.
 *
 * **Portage fidèle de `apps/api/src/rules/schedule.ts`.** Les deux
 * implémentations sont contraintes par les mêmes scénarios JSON
 * (`packages/state-machine-spec`), exécutés ici par JUnit et là-bas par Jest.
 * C'est le seul dispositif qui les empêche de diverger : deux implémentations
 * d'une même règle finissent toujours par se séparer, sauf si un jeu de cas
 * commun les tient.
 *
 * Deux invariants portent tout le reste :
 *  1. le stockage est en UTC, les règles s'interprètent dans le fuseau du dépôt ;
 *  2. la « journée » n'est pas le jour calendaire mais le JOUR OPÉRATIONNEL,
 *     qui commence à [DepotSchedule.operationalDayStart]. Sans cela, un
 *     verrouillage à 02:00 serait rattaché au mauvais jour.
 */

class ScheduleConfigException(message: String) : IllegalArgumentException(message)

data class DayRules(
    /** Heure locale de retour attendue, ou `null` si aucune règle ce jour-là. */
    val returnTime: String?,
    /** Heure locale de verrouillage, ou `null` si aucune règle ce jour-là. */
    val lockTime: String?,
)

data class DayOverride(
    val returnTime: String? = null,
    val lockTime: String? = null,
    /** Distingue « champ absent » de « valeur nulle » lors de la fusion. */
    val hasReturnTime: Boolean = false,
    val hasLockTime: Boolean = false,
)

data class HolidayOverride(
    val date: String,
    /** `null` signifie « aucune règle ce jour-là ». */
    val rules: DayOverride?,
)

data class SpecialPeriod(
    val from: String,
    val to: String,
    val returnTime: String? = null,
    val lockTime: String? = null,
    val hasReturnTime: Boolean = false,
    val hasLockTime: Boolean = false,
)

data class ScheduleOverrides(
    /** Clés « 1 » (lundi) à « 7 » (dimanche), ISO. Une valeur nulle neutralise le jour. */
    val weekdays: Map<String, DayOverride?> = emptyMap(),
    val holidays: List<HolidayOverride> = emptyList(),
    val special: List<SpecialPeriod> = emptyList(),
)

data class DepotSchedule(
    val timezone: String,
    val returnTime: String,
    val lockTime: String,
    val operationalDayStart: String = "04:00",
    val overrides: ScheduleOverrides? = null,
)

private val TIME_PATTERN = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")

fun parseTime(value: String, field: String = "heure"): LocalTime {
    val match = TIME_PATTERN.find(value)
        ?: throw ScheduleConfigException(
            "$field invalide : « $value » (format attendu HH:mm, 00:00 à 23:59).",
        )
    return LocalTime.of(match.groupValues[1].toInt(), match.groupValues[2].toInt())
}

private fun DepotSchedule.zone(): ZoneId =
    try {
        ZoneId.of(timezone)
    } catch (error: Exception) {
        throw ScheduleConfigException("Fuseau horaire inconnu : « $timezone ».")
    }

/** Instant UTC -> date/heure dans le fuseau du dépôt. */
fun DepotSchedule.toDepotTime(instant: Instant): ZonedDateTime =
    instant.atZone(zone())

/**
 * Jour opérationnel auquel appartient un instant, au format « YYYY-MM-DD ».
 * Avant [DepotSchedule.operationalDayStart], l'instant appartient encore à la veille.
 */
fun DepotSchedule.operationalDayOf(instant: Instant): String {
    val local = toDepotTime(instant)
    val start = parseTime(operationalDayStart, "operationalDayStart")
    val day = if (local.toLocalTime() < start) local.toLocalDate().minusDays(1)
    else local.toLocalDate()
    return day.toString()
}

/**
 * Règles applicables à un jour opérationnel donné.
 * Priorité : special > holidays > weekdays > colonnes du dépôt.
 */
fun DepotSchedule.resolveDayRules(operationalDate: String): DayRules {
    var resolved = DayRules(returnTime = returnTime, lockTime = lockTime)
    val overrides = this.overrides ?: return resolved

    val date = try {
        LocalDate.parse(operationalDate)
    } catch (error: Exception) {
        throw ScheduleConfigException("Date invalide : « $operationalDate ».")
    }

    // 3. Jour de semaine — le moins prioritaire des trois niveaux.
    val weekdayKey = date.dayOfWeek.value.toString() // 1 = lundi … 7 = dimanche
    if (overrides.weekdays.containsKey(weekdayKey)) {
        val rule = overrides.weekdays[weekdayKey]
            ?: return DayRules(returnTime = null, lockTime = null)
        resolved = resolved.merge(rule.returnTime, rule.hasReturnTime, rule.lockTime, rule.hasLockTime)
    }

    // 2. Jour férié.
    val holiday = overrides.holidays.firstOrNull { it.date == operationalDate }
    if (holiday != null) {
        val rules = holiday.rules ?: return DayRules(returnTime = null, lockTime = null)
        resolved = resolved.merge(rules.returnTime, rules.hasReturnTime, rules.lockTime, rules.hasLockTime)
    }

    // 1. Période spéciale — la plus prioritaire.
    val special = overrides.special.firstOrNull {
        operationalDate >= it.from && operationalDate <= it.to
    }
    if (special != null) {
        resolved = resolved.merge(
            special.returnTime, special.hasReturnTime,
            special.lockTime, special.hasLockTime,
        )
    }

    return resolved
}

private fun DayRules.merge(
    newReturn: String?,
    hasReturn: Boolean,
    newLock: String?,
    hasLock: Boolean,
): DayRules = DayRules(
    returnTime = if (hasReturn) newReturn else returnTime,
    lockTime = if (hasLock) newLock else lockTime,
)

/**
 * Instant UTC correspondant à une heure locale d'un jour opérationnel.
 *
 * Si l'heure précède le début du jour opérationnel (verrouillage à 02:00 par
 * exemple), elle tombe sur le jour calendaire SUIVANT.
 *
 * Changements d'heure : `ZonedDateTime.of` avance les heures inexistantes
 * (passage à l'heure d'été) et retient la première occurrence des heures
 * ambiguës (heure d'hiver). C'est exactement ce que fait Luxon côté serveur,
 * et ce que décrit docs/06 §4.1.
 */
fun DepotSchedule.instantForLocalTime(
    operationalDate: String,
    localTime: String,
    field: String = "heure",
): Instant {
    val time = parseTime(localTime, field)
    val start = parseTime(operationalDayStart, "operationalDayStart")
    val spillsToNextDay = time < start

    val date = try {
        LocalDate.parse(operationalDate)
    } catch (error: Exception) {
        throw ScheduleConfigException("Date invalide : « $operationalDate ».")
    }

    val target = LocalDateTime.of(
        if (spillsToNextDay) date.plusDays(1) else date,
        time,
    )
    return ZonedDateTime.of(target, zone()).toInstant()
}

/**
 * L'instant est-il postérieur à l'heure de retour du jour opérationnel ?
 * `false` s'il n'y a aucune règle de retour ce jour-là.
 */
fun DepotSchedule.isAfterReturnTime(instant: Instant): Boolean {
    val day = operationalDayOf(instant)
    val rules = resolveDayRules(day)
    val threshold = rules.returnTime ?: return false
    return !instant.isBefore(instantForLocalTime(day, threshold, "returnTime"))
}

/** Instant de retour attendu pour le jour opérationnel de [instant], si défini. */
fun DepotSchedule.returnInstantFor(instant: Instant): Instant? {
    val day = operationalDayOf(instant)
    val rules = resolveDayRules(day)
    val threshold = rules.returnTime ?: return null
    return instantForLocalTime(day, threshold, "returnTime")
}

/**
 * Prochain instant de verrouillage strictement postérieur à [from].
 * `null` si aucune règle dans les [horizonDays] prochains jours — le cas d'un
 * dimanche neutralisé, par exemple.
 */
fun DepotSchedule.nextLockInstant(from: Instant, horizonDays: Int = 8): Instant? {
    var cursor = LocalDate.parse(operationalDayOf(from))

    for (index in 0..horizonDays) {
        val day = cursor.toString()
        val rules = resolveDayRules(day)
        val lock = rules.lockTime
        if (lock != null) {
            val instant = instantForLocalTime(day, lock, "lockTime")
            if (instant.isAfter(from)) return instant
        }
        cursor = cursor.plusDays(1)
    }
    return null
}

private val DEPOT_FORMAT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss 'UTC'xxx")

/** Représentation lisible d'un instant dans le fuseau du dépôt (journalisation). */
fun DepotSchedule.formatInDepotZone(instant: Instant): String =
    toDepotTime(instant).format(DEPOT_FORMAT)
