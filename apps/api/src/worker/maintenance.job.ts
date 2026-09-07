import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommandStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderLock } from './leader-lock';
import { TenantContext } from '../common/tenant-context';

/**
 * Entretien de la base : partitions, purge RGPD, commandes périmées.
 *
 * Ces tâches ne sont pas de l'optimisation : sans création anticipée des
 * partitions, les positions tomberaient dans la partition DEFAULT et la purge
 * cesserait d'être instantanée ; sans purge, la rétention annoncée aux salariés
 * ne serait pas tenue.
 */
@Injectable()
export class MaintenanceJob {
  private readonly logger = new Logger(MaintenanceJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: LeaderLock,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'maintenance' })
  async handle(): Promise<void> {
    await this.lock.run('maintenance', 3600, async () => {
      await TenantContext.system(async () => {
        await this.ensurePartitions();
        await this.expireCommands();
        await this.applyRetention();
      });
    });
  }

  /**
   * Crée les partitions des trois mois à venir.
   *
   * L'avance est délibérée : attacher une partition impose de scanner la
   * partition DEFAULT, opération qui prend un verrou. La faire sur une table
   * vide, la nuit, ne coûte rien ; la faire en urgence sur des millions de
   * lignes bloquerait les insertions de toute la flotte.
   */
  async ensurePartitions(): Promise<string[]> {
    const results: string[] = [];
    for (let i = 0; i <= 3; i++) {
      const rows = await this.prisma.raw.$queryRaw<Array<{ result: string }>>`
        SELECT create_location_events_partition(
          (date_trunc('month', CURRENT_DATE) + (${i} || ' month')::interval)::date
        ) AS result
      `;
      results.push(rows[0].result);
    }
    this.logger.log(`Partitions : ${results.join(', ')}`);
    return results;
  }

  /** Marque périmées les commandes que le téléphone n'a jamais récupérées. */
  async expireCommands(now = new Date()): Promise<number> {
    const { count } = await this.prisma.raw.deviceCommand.updateMany({
      where: {
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
        expiresAt: { lt: now },
      },
      data: { status: CommandStatus.EXPIRED },
    });
    if (count > 0) this.logger.log(`${count} commande(s) périmée(s).`);
    return count;
  }

  /**
   * Purge RGPD.
   *
   * Les positions sont supprimées par **suppression de partition** : instantané,
   * sans gonflement de table ni VACUUM. Les autres tables sont purgées par lots,
   * pour ne pas tenir un verrou long sur une base en production.
   */
  async applyRetention(now = new Date()): Promise<void> {
    const policies = await this.prisma.raw.retentionPolicy.findMany();
    if (policies.length === 0) return;

    // La rétention des positions est une propriété de la partition, donc
    // globale : on retient la durée la PLUS LONGUE demandée par une entreprise,
    // sinon on effacerait les données d'un client pour satisfaire un autre.
    const maxLocationDays = Math.max(...policies.map((p) => p.locationEventsDays));
    await this.dropOldLocationPartitions(maxLocationDays, now);

    for (const policy of policies) {
      const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000);

      const geofence = await this.prisma.raw.geofenceEvent.deleteMany({
        where: {
          companyId: policy.companyId,
          occurredAt: { lt: cutoff(policy.geofenceEventsDays) },
        },
      });
      const security = await this.prisma.raw.securityEvent.deleteMany({
        where: {
          companyId: policy.companyId,
          occurredAt: { lt: cutoff(policy.securityEventsDays) },
        },
      });
      const scans = await this.prisma.raw.barcodeScanEvent.deleteMany({
        where: {
          companyId: policy.companyId,
          scannedAt: { lt: cutoff(policy.securityEventsDays) },
        },
      });

      if (geofence.count + security.count + scans.count > 0) {
        this.logger.log(
          `Purge ${policy.companyId} : ${geofence.count} geofence, ` +
            `${security.count} sécurité, ${scans.count} scans.`,
        );
      }
    }
  }

  private async dropOldLocationPartitions(
    retentionDays: number,
    now: Date,
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

    const partitions = await this.prisma.raw.$queryRaw<Array<{ relname: string }>>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'location_events'
        AND c.relname ~ '^location_events_[0-9]{4}_[0-9]{2}$'
      ORDER BY c.relname
    `;

    for (const { relname } of partitions) {
      const match = /^location_events_(\d{4})_(\d{2})$/.exec(relname);
      if (!match) continue;

      // Une partition n'est supprimable que si son mois entier est hors
      // rétention : on compare la fin du mois, jamais son début.
      const endOfMonth = new Date(
        Date.UTC(Number(match[1]), Number(match[2]), 1),
      );
      if (endOfMonth > cutoff) continue;

      await this.prisma.raw.$executeRawUnsafe(`DROP TABLE IF EXISTS "${relname}"`);
      this.logger.log(`Partition supprimée (rétention) : ${relname}`);
    }
  }
}
