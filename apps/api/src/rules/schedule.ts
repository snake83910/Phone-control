import { DateTime } from 'luxon';

/**
 * Résolution des règles horaires d'un dépôt — cf. docs/06 §4.
 *
 * Fonctions PURES : aucune dépendance à Nest, à Prisma ni à l'horloge système.
 * L'instant courant est toujours passé en paramètre, ce qui rend chaque règle
 * testable et reproductible.
 *
 * Deux invariants tiennent tout le reste :
 *  1. le stockage est en UTC, les règles s'interprètent dans le fuseau du dépôt ;
 *  2. la « journée » n'est pas le jour calendaire mais le JOUR OPÉRATIONNEL,
 *     qui commence à operationalDayStart (04:00 par défaut). Sans cela, un
 *     verrouillage à 02:00 serait rattaché au mauvais jour.
 */

export interface DayRules {
  /** Heure locale de retour attendue, ou null si aucune règle ce jour-là. */
  returnTime: string | null;
  /** Heure locale de verrouillage, ou null si aucune règle ce jour-là. */
  lockTime: string | null;
}

export interface ScheduleOverrides {
  /** Clés « 1 » (lundi) à « 7 » (dimanche), ISO. `null` = aucune règle. */
  weekdays?: Record<string, Partial<DayRules> | null>;
  /** Jours fériés ou exceptionnels, date au format ISO « YYYY-MM-DD ». */
  holidays?: Array<{ date: string; rules?: Partial<DayRules> | null }>;
  /** Périodes spéciales, bornes incluses. */
  special?: Array<{
    from: string;
    to: string;
    returnTime?: string | null;
    lockTime?: string | null;
  }>;
}

export interface DepotSchedule {
  timezone: string;
  returnTime: string;
  lockTime: string;
  operationalDayStart: string;
  overrides?: ScheduleOverrides | null;
}

export class ScheduleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleConfigError';
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(value: string, field = 'heure'): { hour: number; minute: number } {
  const m = TIME_RE.exec(value);
  if (!m) {
    throw new ScheduleConfigError(
      `${field} invalide : « ${value} » (format attendu HH:mm, 00:00 à 23:59).`,
    );
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function assertZone(timezone: string): void {
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new ScheduleConfigError(`Fuseau horaire inconnu : « ${timezone} ».`);
  }
}

/** Instant UTC -> DateTime dans le fuseau du dépôt. */
export function toDepotTime(schedule: DepotSchedule, instant: Date): DateTime {
  assertZone(schedule.timezone);
  return DateTime.fromJSDate(instant, { zone: schedule.timezone });
}

/**
 * Jour opérationnel auquel appartient un instant, au format « YYYY-MM-DD ».
 * Avant operationalDayStart, l'instant appartient encore à la veille.
 */
export function operationalDayOf(schedule: DepotSchedule, instant: Date): string {
  const local = toDepotTime(schedule, instant);
  const start = parseTime(schedule.operationalDayStart, 'operationalDayStart');
  const minutesNow = local.hour * 60 + local.minute;
  const minutesStart = start.hour * 60 + start.minute;
  const day = minutesNow < minutesStart ? local.minus({ days: 1 }) : local;
  return day.toISODate()!;
}

/**
 * Règles applicables à un jour opérationnel donné.
 * Priorité : special > holidays > weekdays > colonnes du dépôt.
 */
export function resolveDayRules(
  schedule: DepotSchedule,
  operationalDate: string,
): DayRules {
  const base: DayRules = {
    returnTime: schedule.returnTime,
    lockTime: schedule.lockTime,
  };
  const overrides = schedule.overrides;
  if (!overrides) return base;

  const date = DateTime.fromISO(operationalDate, { zone: schedule.timezone });
  if (!date.isValid) {
    throw new ScheduleConfigError(`Date invalide : « ${operationalDate} ».`);
  }

  // 3. Jour de semaine (le moins prioritaire des trois niveaux de surcharge).
  let resolved: DayRules = { ...base };
  const weekdayKey = String(date.weekday); // 1 = lundi … 7 = dimanche
  if (overrides.weekdays && weekdayKey in overrides.weekdays) {
    const rule = overrides.weekdays[weekdayKey];
    if (rule === null) return { returnTime: null, lockTime: null };
    resolved = {
      returnTime: rule.returnTime !== undefined ? rule.returnTime : resolved.returnTime,
      lockTime: rule.lockTime !== undefined ? rule.lockTime : resolved.lockTime,
    };
  }

  // 2. Jour férié.
  const holiday = overrides.holidays?.find((h) => h.date === operationalDate);
  if (holiday) {
    if (holiday.rules === null || holiday.rules === undefined) {
      return { returnTime: null, lockTime: null };
    }
    resolved = {
      returnTime:
        holiday.rules.returnTime !== undefined
          ? holiday.rules.returnTime
          : resolved.returnTime,
      lockTime:
        holiday.rules.lockTime !== undefined ? holiday.rules.lockTime : resolved.lockTime,
    };
  }

  // 1. Période spéciale (la plus prioritaire).
  const special = overrides.special?.find(
    (s) => operationalDate >= s.from && operationalDate <= s.to,
  );
  if (special) {
    resolved = {
      returnTime:
        special.returnTime !== undefined ? special.returnTime : resolved.returnTime,
      lockTime: special.lockTime !== undefined ? special.lockTime : resolved.lockTime,
    };
  }

  return resolved;
}

/**
 * Instant UTC correspondant à une heure locale d'un jour opérationnel.
 *
 * Si l'heure est antérieure au début du jour opérationnel (verrouillage à 02:00
 * par exemple), elle tombe sur le jour calendaire SUIVANT.
 *
 * Changements d'heure : Luxon avance les heures inexistantes (passage à l'heure
 * d'été) et retient la première occurrence des heures ambiguës (heure d'hiver).
 * C'est exactement le comportement décrit dans docs/06 §4.1.
 */
export function instantForLocalTime(
  schedule: DepotSchedule,
  operationalDate: string,
  localTime: string,
  field = 'heure',
): Date {
  assertZone(schedule.timezone);
  const time = parseTime(localTime, field);
  const start = parseTime(schedule.operationalDayStart, 'operationalDayStart');

  const spillsToNextDay =
    time.hour * 60 + time.minute < start.hour * 60 + start.minute;

  const base = DateTime.fromISO(operationalDate, { zone: schedule.timezone });
  if (!base.isValid) {
    throw new ScheduleConfigError(`Date invalide : « ${operationalDate} ».`);
  }

  const dt = base
    .plus({ days: spillsToNextDay ? 1 : 0 })
    .set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });

  return dt.toUTC().toJSDate();
}

/**
 * L'instant est-il postérieur à l'heure de retour du jour opérationnel ?
 * `false` s'il n'y a aucune règle de retour ce jour-là.
 */
export function isAfterReturnTime(schedule: DepotSchedule, instant: Date): boolean {
  const day = operationalDayOf(schedule, instant);
  const rules = resolveDayRules(schedule, day);
  if (!rules.returnTime) return false;
  const threshold = instantForLocalTime(schedule, day, rules.returnTime, 'returnTime');
  return instant.getTime() >= threshold.getTime();
}

/**
 * Prochain instant de verrouillage strictement postérieur à `from`.
 * `null` si aucune règle de verrouillage dans les `horizonDays` prochains jours
 * (cas d'un dimanche sans règle, par exemple).
 */
export function nextLockInstant(
  schedule: DepotSchedule,
  from: Date,
  horizonDays = 8,
): Date | null {
  const startDay = operationalDayOf(schedule, from);
  let cursor = DateTime.fromISO(startDay, { zone: schedule.timezone });

  for (let i = 0; i <= horizonDays; i++) {
    const day = cursor.toISODate()!;
    const rules = resolveDayRules(schedule, day);
    if (rules.lockTime) {
      const instant = instantForLocalTime(schedule, day, rules.lockTime, 'lockTime');
      if (instant.getTime() > from.getTime()) return instant;
    }
    cursor = cursor.plus({ days: 1 });
  }
  return null;
}

/** Instant de retour attendu pour le jour opérationnel de `instant`, si défini. */
export function returnInstantFor(schedule: DepotSchedule, instant: Date): Date | null {
  const day = operationalDayOf(schedule, instant);
  const rules = resolveDayRules(schedule, day);
  if (!rules.returnTime) return null;
  return instantForLocalTime(schedule, day, rules.returnTime, 'returnTime');
}

/** Représentation lisible d'un instant dans le fuseau du dépôt (journalisation). */
export function formatInDepotZone(schedule: DepotSchedule, instant: Date): string {
  return toDepotTime(schedule, instant).toFormat("yyyy-MM-dd HH:mm:ss 'UTC'ZZ");
}
