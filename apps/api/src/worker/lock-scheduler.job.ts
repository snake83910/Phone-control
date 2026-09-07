import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AlertSeverity,
  AlertType,
  CommandType,
  DeviceEnrollmentStatus,
  Depot,
  SessionEndReason,
  SessionState,
  SessionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommandsService } from '../devices/commands.service';
import { SessionsService } from '../sessions/sessions.service';
import { AlertsService } from '../alerts/alerts.service';
import { LeaderLock } from './leader-lock';
import { TenantContext } from '../common/tenant-context';
import {
  DepotSchedule,
  formatInDepotZone,
  nextLockInstant,
} from '../rules/schedule';

/**
 * Verrouillage planifié (règle « 22h ») et clôture des sessions expirées.
 *
 * La tâche s'exécute chaque minute et cherche les dépôts dont l'heure de
 * verrouillage vient de passer. Elle ne suppose jamais qu'elle a tourné à
 * l'heure exacte : elle examine une fenêtre couvrant les dernières minutes,
 * pour qu'un redémarrage à 21 h 59 ne fasse pas sauter le verrouillage de 22 h.
 *
 * Cette planification serveur est le chemin nominal, PAS la garantie : le
 * téléphone possède sa propre alarme locale et se verrouille même hors ligne
 * (docs/02 §5).
 */
@Injectable()
export class LockSchedulerJob {
  private readonly logger = new Logger(LockSchedulerJob.name);

  /** Fenêtre de rattrapage : couvre un redémarrage ou une minute manquée. */
  private static readonly WINDOW_MINUTES = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
    private readonly sessions: SessionsService,
    private readonly alerts: AlertsService,
    private readonly lock: LeaderLock,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'lock-scheduler' })
  async handle(): Promise<void> {
    await this.lock.run('lock-scheduler', 50, async () => {
      await TenantContext.system(() => this.run());
    });
  }

  /**
   * @param companyIds restreint le balayage à ces entreprises. En exploitation,
   * la tâche parcourt toute la base ; les tests s'en servent pour rester
   * hermétiques et ne pas agir sur les données des autres scénarios.
   */
  async run(now = new Date(), companyIds?: string[]): Promise<void> {
    const depots = await this.prisma.raw.depot.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(companyIds ? { companyId: { in: companyIds } } : {}),
      },
    });

    for (const depot of depots) {
      try {
        await this.handleDepot(depot, now);
      } catch (err) {
        this.logger.error(
          `Verrouillage planifié du dépôt ${depot.name} : ${(err as Error).message}`,
        );
      }
    }

    await this.expireSessions(now, companyIds);
  }

  private async handleDepot(depot: Depot, now: Date): Promise<void> {
    const schedule = toSchedule(depot);
    const windowStart = new Date(
      now.getTime() - LockSchedulerJob.WINDOW_MINUTES * 60_000,
    );

    // Le prochain verrouillage postérieur au début de la fenêtre : s'il est
    // déjà passé, c'est qu'il doit être déclenché maintenant.
    const due = nextLockInstant(schedule, windowStart);
    if (!due || due > now) return;

    // L'identifiant d'idempotence porte l'instant exact : réexécuter la tâche
    // dans la même fenêtre ne crée aucune commande supplémentaire.
    const stamp = due.toISOString();

    const devices = await this.prisma.raw.device.findMany({
      where: {
        depotId: depot.id,
        deletedAt: null,
        enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
        revokedAt: null,
      },
      select: { id: true, companyId: true, assetTag: true },
    });

    if (devices.length === 0) return;

    this.logger.log(
      `Verrouillage planifié — ${depot.name} à ${formatInDepotZone(schedule, due)} : ` +
        `${devices.length} téléphone(s).`,
    );

    for (const device of devices) {
      await this.commands.enqueue({
        companyId: device.companyId,
        deviceId: device.id,
        command: CommandType.LOCK_DEVICE,
        payload: { reason: 'SCHEDULED_LOCK', scheduledFor: stamp },
        // Une commande de verrouillage n'a plus de sens le lendemain matin.
        ttlMinutes: 12 * 60,
        idempotencyKey: `scheduled-lock:${stamp}`,
        priority: 90,
      });
    }

    await this.reportNotReturned(depot, schedule, due);
  }

  /**
   * Téléphones jamais revenus au dépôt à l'heure de verrouillage.
   * Ce cas ne produit aucun événement de geofence : il ne peut être détecté
   * que par l'absence, donc par une vérification à heure fixe (§56).
   */
  private async reportNotReturned(
    depot: Depot,
    schedule: DepotSchedule,
    due: Date,
  ): Promise<void> {
    const policy = await this.prisma.raw.retentionPolicy.findFirst({
      where: { companyId: depot.companyId },
    });
    void policy; // la politique « non retourné » suivra le même chemin

    const sessions = await this.prisma.raw.session.findMany({
      where: {
        depotId: depot.id,
        status: SessionStatus.ACTIVE,
        state: SessionState.ACTIVE,
        returnedAt: null,
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        device: { select: { id: true, assetTag: true } },
      },
    });

    for (const session of sessions) {
      await this.alerts.raise({
        companyId: session.companyId,
        deviceId: session.deviceId,
        userId: session.userId,
        depotId: depot.id,
        sessionId: session.id,
        type: AlertType.NOT_RETURNED,
        severity: AlertSeverity.MEDIUM,
        title: 'Téléphone non retourné',
        message:
          `${session.device.assetTag} (${session.user.firstName} ${session.user.lastName}) ` +
          `n'est pas revenu au dépôt ${depot.name} à l'heure de verrouillage ` +
          `(${formatInDepotZone(schedule, due)}).`,
        dedupeKey: `not-returned:${session.id}`,
        context: { depot: depot.name, scheduledFor: due.toISOString() },
      });
    }
  }

  /** Sessions dépassant leur durée maximale, indépendamment du dépôt. */
  private async expireSessions(
    now: Date,
    companyIds?: string[],
  ): Promise<void> {
    const expired = await this.sessions.expireOverdue(now, companyIds);
    if (expired.length === 0) return;

    this.logger.log(`${expired.length} session(s) expirée(s).`);

    for (const session of expired) {
      await this.commands.enqueue({
        companyId: session.companyId,
        deviceId: session.deviceId,
        command: CommandType.FORCE_LOGOUT,
        payload: { reason: SessionEndReason.EXPIRED },
        ttlMinutes: 12 * 60,
        idempotencyKey: `session-expired:${session.id}`,
        priority: 100,
      });
    }
  }
}

function toSchedule(depot: Depot): DepotSchedule {
  return {
    timezone: depot.timezone,
    returnTime: depot.returnTime,
    lockTime: depot.lockTime,
    operationalDayStart: depot.operationalDayStart,
    overrides: depot.scheduleOverrides as never,
  };
}
