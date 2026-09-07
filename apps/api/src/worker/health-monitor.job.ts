import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AlertSeverity,
  AlertStatus,
  AlertType,
  DeviceEnrollmentStatus,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { LeaderLock } from './leader-lock';
import { TenantContext } from '../common/tenant-context';
import { newId } from '../common/ids';

/**
 * Surveillance de la santé de la flotte.
 *
 * Un téléphone éteint, sans réseau ou dont la batterie est vide ne signale rien
 * de lui-même : c'est précisément le cas qui compte. Son absence ne peut être
 * détectée que côté serveur, par comparaison avec le dernier signal reçu.
 */
@Injectable()
export class HealthMonitorJob {
  private readonly logger = new Logger(HealthMonitorJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly lock: LeaderLock,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'health-monitor' })
  async handle(): Promise<void> {
    await this.lock.run('health-monitor', 250, async () => {
      await TenantContext.system(() => this.run());
    });
  }

  /** @param companyIds restreint le balayage (voir LockSchedulerJob.run). */
  async run(now = new Date(), companyIds?: string[]): Promise<void> {
    const companies = await this.prisma.raw.company.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(companyIds ? { id: { in: companyIds } } : {}),
      },
      select: { id: true },
    });

    for (const company of companies) {
      try {
        await this.checkCompany(company.id, now);
      } catch (err) {
        this.logger.error(
          `Surveillance de l'entreprise ${company.id} : ${(err as Error).message}`,
        );
      }
    }
  }

  private async checkCompany(companyId: string, now: Date): Promise<void> {
    const settings = await this.settings.resolveForCompany(companyId);
    const threshold = new Date(
      now.getTime() - settings.offlineAlertDelayMinutes * 60_000,
    );

    const offline = await this.prisma.raw.device.findMany({
      where: {
        companyId,
        deletedAt: null,
        enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
        revokedAt: null,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: threshold } }],
      },
      select: {
        id: true,
        assetTag: true,
        depotId: true,
        lastSeenAt: true,
        lastLatitude: true,
        lastLongitude: true,
      },
    });

    for (const device of offline) {
      const since = device.lastSeenAt
        ? `${Math.round((now.getTime() - device.lastSeenAt.getTime()) / 60_000)} min`
        : 'jamais vu';

      await this.alerts.raise({
        companyId,
        deviceId: device.id,
        depotId: device.depotId,
        type: AlertType.DEVICE_OFFLINE,
        severity: AlertSeverity.MEDIUM,
        title: 'Téléphone hors ligne',
        message:
          `${device.assetTag} n'a pas donné signe de vie depuis ${since} ` +
          `(seuil : ${settings.offlineAlertDelayMinutes} min).`,
        // Une seule alerte tant que l'appareil reste muet. Sans cette clé, un
        // téléphone éteint le week-end produirait une alerte toutes les cinq
        // minutes, soit près de six cents.
        dedupeKey: `device-offline:${device.id}`,
        latitude: device.lastLatitude,
        longitude: device.lastLongitude,
        context: { lastSeenAt: device.lastSeenAt, assetTag: device.assetTag },
      });

      await this.prisma.raw.securityEvent.create({
        data: {
          id: newId(),
          companyId,
          deviceId: device.id,
          type: SecurityEventType.DEVICE_OFFLINE,
          severity: SecuritySeverity.MEDIUM,
          occurredAt: now,
          metadata: { lastSeenAt: device.lastSeenAt } as Prisma.InputJsonValue,
        },
      });
    }

    await this.closeRecoveredAlerts(companyId, threshold);
  }

  /**
   * Referme les alertes « hors ligne » des téléphones revenus.
   * Une alerte qui ne se referme jamais finit par être ignorée, ce qui vide de
   * sens tout le dispositif d'alerte.
   */
  private async closeRecoveredAlerts(
    companyId: string,
    threshold: Date,
  ): Promise<void> {
    const open = await this.prisma.raw.alert.findMany({
      where: {
        companyId,
        type: AlertType.DEVICE_OFFLINE,
        status: AlertStatus.OPEN,
        deviceId: { not: null },
      },
      select: { id: true, deviceId: true },
    });

    if (open.length === 0) return;

    const recovered = await this.prisma.raw.device.findMany({
      where: {
        id: { in: open.map((a) => a.deviceId!) },
        lastSeenAt: { gte: threshold },
      },
      select: { id: true },
    });

    if (recovered.length === 0) return;

    const recoveredIds = new Set(recovered.map((d) => d.id));
    const toClose = open.filter((a) => recoveredIds.has(a.deviceId!));

    await this.prisma.raw.alert.updateMany({
      where: { id: { in: toClose.map((a) => a.id) } },
      data: { status: AlertStatus.AUTO_CLOSED, resolvedAt: new Date() },
    });

    this.logger.log(`${toClose.length} alerte(s) « hors ligne » refermée(s).`);
  }
}
