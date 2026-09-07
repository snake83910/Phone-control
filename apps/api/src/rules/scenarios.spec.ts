import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyFix,
  evaluateGeofenceTransition,
  haversineMeters,
  TransitionKind,
} from './geofence-rules';
import {
  DepotSchedule,
  instantForLocalTime,
  nextLockInstant,
  operationalDayOf,
  resolveDayRules,
  ScheduleOverrides,
} from './schedule';

/**
 * Exécution des scénarios partagés (packages/state-machine-spec).
 *
 * Ces mêmes fichiers alimenteront la suite JUnit du module Android en Phase 4.
 * C'est le seul dispositif qui empêche les deux implémentations du moteur —
 * TypeScript ici, Kotlin sur le téléphone — de diverger silencieusement.
 */

const SCENARIOS_DIR = resolve(
  __dirname,
  '../../../../packages/state-machine-spec/scenarios',
);

function load<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(SCENARIOS_DIR, file), 'utf8')) as T;
}

// ---------------------------------------------------------------------------

describe('Scénarios partagés — classification géométrique', () => {
  const spec = load<{
    cases: Array<{
      name: string;
      distanceMeters: number;
      accuracyMeters: number;
      radiusMeters: number;
      hysteresisMeters: number;
      expect: string;
    }>;
    distances: Array<{
      name: string;
      from: { latitude: number; longitude: number };
      to: { latitude: number; longitude: number };
      expectMeters: number;
      toleranceMeters: number;
    }>;
  }>('geofence-classification.json');

  it.each(spec.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(
      classifyFix({
        distanceMeters: c.distanceMeters,
        accuracyMeters: c.accuracyMeters,
        radiusMeters: c.radiusMeters,
        hysteresisMeters: c.hysteresisMeters,
      }),
    ).toBe(c.expect);
  });

  it.each(spec.distances.map((d) => [d.name, d] as const))(
    'distance — %s',
    (_name, d) => {
      const meters = haversineMeters(
        d.from.latitude,
        d.from.longitude,
        d.to.latitude,
        d.to.longitude,
      );
      expect(Math.abs(meters - d.expectMeters)).toBeLessThanOrEqual(
        d.toleranceMeters,
      );
    },
  );
});

// ---------------------------------------------------------------------------

describe('Scénarios partagés — règles du dépôt', () => {
  const spec = load<{
    depot: DepotSchedule;
    scenarios: Array<{
      name: string;
      initialState: 'ACTIVE' | 'RETURNED';
      depotOverrides?: ScheduleOverrides;
      steps: Array<{
        at: string;
        transition: TransitionKind;
        expect: {
          eventType: string;
          sessionState: 'ACTIVE' | 'RETURNED';
          markReturned: boolean;
          alert: string | null;
        };
      }>;
    }>;
  }>('depot-rules.json');

  it.each(spec.scenarios.map((s) => [s.name, s] as const))('%s', (_name, s) => {
    const schedule: DepotSchedule = {
      ...spec.depot,
      overrides: s.depotOverrides ?? null,
    };

    let state = s.initialState;

    for (const step of s.steps) {
      const decision = evaluateGeofenceTransition({
        transition: step.transition,
        occurredAt: new Date(step.at),
        schedule,
        sessionState: state,
      });

      expect({
        eventType: decision.eventType,
        sessionState: decision.nextSessionState,
        markReturned: decision.markReturned,
        alert: decision.alert?.type ?? null,
      }).toEqual(step.expect);

      state = decision.nextSessionState;
    }
  });
});

// ---------------------------------------------------------------------------

describe('Scénarios partagés — règles horaires', () => {
  const spec = load<{
    depot: DepotSchedule;
    operationalDay: Array<{ name: string; at: string; expect: string }>;
    nextLock: Array<{
      name: string;
      from: string;
      expectUtc: string;
      overrides?: ScheduleOverrides;
      lockTime?: string;
    }>;
    dayRules: Array<{
      name: string;
      date: string;
      overrides?: ScheduleOverrides;
      expect: { returnTime: string | null; lockTime: string | null };
    }>;
    dstEdgeCases: Array<{
      name: string;
      date: string;
      localTime: string;
      operationalDayStart: string;
      expectUtc?: string;
      expectValid?: boolean;
    }>;
    timezones: Array<{
      name: string;
      timezone: string;
      date: string;
      localTime: string;
      expectUtc: string;
    }>;
  }>('schedule.json');

  it.each(spec.operationalDay.map((c) => [c.name, c] as const))(
    'jour opérationnel — %s',
    (_name, c) => {
      expect(operationalDayOf(spec.depot, new Date(c.at))).toBe(c.expect);
    },
  );

  it.each(spec.nextLock.map((c) => [c.name, c] as const))(
    'prochain verrouillage — %s',
    (_name, c) => {
      const schedule: DepotSchedule = {
        ...spec.depot,
        ...(c.lockTime ? { lockTime: c.lockTime } : {}),
        overrides: c.overrides ?? null,
      };
      const instant = nextLockInstant(schedule, new Date(c.from));
      expect(instant).not.toBeNull();
      expect(instant!.toISOString()).toBe(c.expectUtc);
    },
  );

  it.each(spec.dayRules.map((c) => [c.name, c] as const))(
    'règles du jour — %s',
    (_name, c) => {
      const schedule: DepotSchedule = {
        ...spec.depot,
        overrides: c.overrides ?? null,
      };
      expect(resolveDayRules(schedule, c.date)).toEqual(c.expect);
    },
  );

  it.each(spec.dstEdgeCases.map((c) => [c.name, c] as const))(
    'changement d’heure — %s',
    (_name, c) => {
      const schedule: DepotSchedule = {
        ...spec.depot,
        operationalDayStart: c.operationalDayStart,
      };
      const instant = instantForLocalTime(schedule, c.date, c.localTime);
      if (c.expectUtc) {
        expect(instant.toISOString()).toBe(c.expectUtc);
      } else {
        expect(Number.isNaN(instant.getTime())).toBe(false);
      }
    },
  );

  it.each(spec.timezones.map((c) => [c.name, c] as const))(
    'fuseau — %s',
    (_name, c) => {
      const schedule: DepotSchedule = { ...spec.depot, timezone: c.timezone };
      expect(
        instantForLocalTime(schedule, c.date, c.localTime).toISOString(),
      ).toBe(c.expectUtc);
    },
  );
});
