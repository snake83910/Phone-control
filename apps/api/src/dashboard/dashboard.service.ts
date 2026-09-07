import { Injectable } from '@nestjs/common';
import {
  AlertSeverity,
  AlertStatus,
  DeviceEnrollmentStatus,
  DeviceState,
  SessionState,
  SessionStatus,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

export interface DashboardSummary {
  devices: {
    total: number;
    enrolled: number;
    pending: number;
    active: number;
    locked: number;
    returned: number;
    offline: number;
    deviceOwnerUnconfirmed: number;
  };
  users: { active: number; inSession: number };
  sessions: { active: number; returned: number; notReturned: number };
  alerts: {
    open: number;
    today: number;
    bySeverity: Record<AlertSeverity, number>;
  };
  health: { lowBattery: number; gpsDisabled: number };
  generatedAt: string;
}

/**
 * Indicateurs de la page d'accueil (§34 de la spécification).
 *
 * Toutes les valeurs proviennent de `count` avec filtre, jamais d'un chargement
 * de collection suivi d'un comptage applicatif : sur une flotte de plusieurs
 * milliers de téléphones, la différence est celle entre 12 ms et 2 s.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async summary(companyId: string): Promise<DashboardSummary> {
    const defaults = await this.settings.resolveForCompany(companyId);
    const offlineThreshold = new Date(
      Date.now() - defaults.offlineAlertDelayMinutes * 60_000,
    );
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const db = this.prisma.db;

    const [
      total,
      enrolled,
      pending,
      active,
      locked,
      returned,
      offline,
      deviceOwnerUnconfirmed,
      usersActive,
      sessionsActive,
      sessionsReturned,
      alertsOpen,
      alertsToday,
      lowBattery,
      gpsDisabled,
      severities,
    ] = await Promise.all([
      db.device.count({ where: { deletedAt: null } }),
      db.device.count({
        where: { deletedAt: null, enrollmentStatus: DeviceEnrollmentStatus.ENROLLED },
      }),
      db.device.count({
        where: { deletedAt: null, enrollmentStatus: DeviceEnrollmentStatus.PENDING },
      }),
      db.device.count({ where: { deletedAt: null, state: DeviceState.ACTIVE } }),
      db.device.count({ where: { deletedAt: null, state: DeviceState.LOCKED } }),
      db.device.count({ where: { deletedAt: null, state: DeviceState.RETURNED } }),
      db.device.count({
        where: {
          deletedAt: null,
          enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: offlineThreshold } }],
        },
      }),
      db.device.count({
        where: {
          deletedAt: null,
          enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
          deviceOwnerActive: false,
        },
      }),
      db.user.count({ where: { deletedAt: null, status: UserStatus.ACTIVE } }),
      db.session.count({ where: { status: SessionStatus.ACTIVE } }),
      db.session.count({
        where: { status: SessionStatus.ACTIVE, state: SessionState.RETURNED },
      }),
      db.alert.count({ where: { status: AlertStatus.OPEN } }),
      db.alert.count({ where: { createdAt: { gte: startOfToday } } }),
      db.device.count({
        where: {
          deletedAt: null,
          batteryLevel: { lte: defaults.batteryAlertThreshold },
          isCharging: false,
        },
      }),
      db.device.count({ where: { deletedAt: null, gpsEnabled: false } }),
      db.alert.groupBy({
        by: ['severity'],
        where: { status: AlertStatus.OPEN },
        _count: { _all: true },
      }),
    ]);

    const bySeverity = {
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0,
    } as Record<AlertSeverity, number>;
    for (const row of severities) {
      bySeverity[row.severity] = row._count._all;
    }

    return {
      devices: {
        total,
        enrolled,
        pending,
        active,
        locked,
        returned,
        offline,
        deviceOwnerUnconfirmed,
      },
      users: { active: usersActive, inSession: sessionsActive },
      sessions: {
        active: sessionsActive,
        returned: sessionsReturned,
        // « Non retourné » n'est pas un état stocké : c'est une session encore
        // ouverte qui n'a jamais franchi le geofence après l'heure de retour.
        notReturned: sessionsActive - sessionsReturned,
      },
      alerts: { open: alertsOpen, today: alertsToday, bySeverity },
      health: { lowBattery, gpsDisabled },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Activité des N derniers jours, aujourd'hui compris.
   *
   * Les bornes sont calculées en UTC, comme `date_trunc` côté PostgreSQL : un
   * découpage en heure locale décalerait les seaux d'une à deux heures et
   * ferait disparaître la journée en cours du graphique.
   */
  async activity(companyId: string, days = 7) {
    const now = new Date();
    const startOfTodayUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const since = new Date(startOfTodayUtc - (days - 1) * 86_400_000);

    const [sessions, alerts] = await Promise.all([
      this.prisma.raw.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT date_trunc('day', started_at) AS day, count(*) AS count
        FROM sessions
        WHERE company_id = ${companyId}::uuid AND started_at >= ${since}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.raw.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT date_trunc('day', created_at) AS day, count(*) AS count
        FROM alerts
        WHERE company_id = ${companyId}::uuid AND created_at >= ${since}
        GROUP BY 1 ORDER BY 1
      `,
    ]);

    const index = new Map<string, { day: string; sessions: number; alerts: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      index.set(key, { day: key, sessions: 0, alerts: 0 });
    }
    for (const row of sessions) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = index.get(key);
      if (entry) entry.sessions = Number(row.count);
    }
    for (const row of alerts) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = index.get(key);
      if (entry) entry.alerts = Number(row.count);
    }

    return [...index.values()];
  }
}
