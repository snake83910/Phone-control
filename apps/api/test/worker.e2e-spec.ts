import { randomUUID } from 'node:crypto';
import {
  AlertStatus,
  CommandStatus,
  CommandType,
  SessionStatus,
} from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  createTestApp,
  deviceAccessToken,
  seedCompany,
  seedDevice,
  seedDriver,
  uniqueSuffix,
} from './fixtures';
import { AlertsService } from '../src/alerts/alerts.service';
import { CommandsService } from '../src/devices/commands.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { SettingsService } from '../src/settings/settings.service';
import { RedisService } from '../src/redis/redis.service';
import { LeaderLock } from '../src/worker/leader-lock';
import { LockSchedulerJob } from '../src/worker/lock-scheduler.job';
import { HealthMonitorJob } from '../src/worker/health-monitor.job';
import { MaintenanceJob } from '../src/worker/maintenance.job';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Tâches planifiées.
 *
 * Les jobs sont instanciés directement, sans `ScheduleModule` : on teste la
 * logique, pas la capacité de `node-cron` à déclencher une minuterie. Cela
 * permet aussi de passer un instant arbitraire — impossible autrement de
 * vérifier le comportement à 22 h un mardi de décembre.
 */
describe('Tâches planifiées', () => {
  let ctx: TestContext;
  let lockScheduler: LockSchedulerJob;
  let healthMonitor: HealthMonitorJob;
  let maintenance: MaintenanceJob;

  beforeAll(async () => {
    ctx = await createTestApp();

    const lock = new LeaderLock(ctx.app.get(RedisService));
    lockScheduler = new LockSchedulerJob(
      ctx.prisma,
      ctx.app.get(CommandsService),
      ctx.app.get(SessionsService),
      ctx.app.get(AlertsService),
      lock,
    );
    healthMonitor = new HealthMonitorJob(
      ctx.prisma,
      ctx.app.get(AlertsService),
      ctx.app.get(SettingsService),
      lock,
    );
    maintenance = new MaintenanceJob(ctx.prisma, lock);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  async function openSession(company: CompanyFixture, tag: string, barcode: string) {
    const device = await seedDevice(ctx, company, tag);
    await seedDriver(ctx, company, {
      firstName: 'Rémy',
      lastName: 'Simon',
      barcode,
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      headers: { authorization: `Bearer ${token}` },
      payload: { barcode, deviceId: device.id },
    });
    expect(res.json().success).toBe(true);
    return { device, sessionId: res.json().session.id as string };
  }

  // -------------------------------------------------------------------------

  it('verrouillage 22h : une commande LOCK_DEVICE par téléphone du dépôt', async () => {
    const company = await seedCompany(ctx);
    const { device } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    // Mardi 8 septembre 2026, 22 h 01 heure de Paris.
    await TenantContext.system(() =>
      lockScheduler.run(new Date('2026-09-08T22:01:00+02:00'), [company.company.id]),
    );

    const command = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.findFirst({
        where: { deviceId: device.id, command: CommandType.LOCK_DEVICE },
      }),
    );

    expect(command).not.toBeNull();
    expect(command?.status).toBe(CommandStatus.PENDING);
    expect(command?.payload).toMatchObject({ reason: 'SCHEDULED_LOCK' });
  });

  it('la tâche est idempotente : deux exécutions dans la même fenêtre', async () => {
    const company = await seedCompany(ctx);
    const { device } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    const at = new Date('2026-09-08T22:01:00+02:00');
    await TenantContext.system(() => lockScheduler.run(at, [company.company.id]));
    await TenantContext.system(() =>
      lockScheduler.run(new Date(at.getTime() + 60_000), [company.company.id]),
    );

    const commands = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.count({
        where: { deviceId: device.id, command: CommandType.LOCK_DEVICE },
      }),
    );

    // Sans clé d'idempotence, le téléphone recevrait un ordre par minute
    // pendant toute la fenêtre de rattrapage.
    expect(commands).toBe(1);
  });

  it('avant l’heure de verrouillage, aucune commande n’est émise', async () => {
    const company = await seedCompany(ctx);
    const { device } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    await TenantContext.system(() =>
      lockScheduler.run(new Date('2026-09-08T19:00:00+02:00'), [company.company.id]),
    );

    const commands = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.count({
        // Uniquement les verrouillages : jouer la tâche à une date future rend
        // au passage toutes les sessions expirées, ce qui produit légitimement
        // un FORCE_LOGOUT sans rapport avec ce que vérifie ce test.
        where: { deviceId: device.id, command: CommandType.LOCK_DEVICE },
      }),
    );
    expect(commands).toBe(0);
  });

  it('un dépôt sans règle ce jour-là n’est pas verrouillé', async () => {
    // Dimanche neutralisé, comme dans le jeu de démonstration.
    const company = await seedCompany(ctx, {
      scheduleOverrides: { weekdays: { '7': null } },
    });
    const { device } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    // Dimanche 6 septembre 2026, 22 h 01.
    await TenantContext.system(() =>
      lockScheduler.run(new Date('2026-09-06T22:01:00+02:00'), [company.company.id]),
    );

    const commands = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.count({
        where: { deviceId: device.id, command: CommandType.LOCK_DEVICE },
      }),
    );
    expect(commands).toBe(0);
  });

  it('le fuseau du dépôt est respecté : 22 h locales, pas 22 h UTC', async () => {
    const company = await seedCompany(ctx, { timezone: 'Indian/Reunion' });
    const { device } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    // 22 h à La Réunion = 18 h UTC. À 22 h UTC, il y est 2 h du matin :
    // le verrouillage a déjà eu lieu quatre heures plus tôt.
    await TenantContext.system(() =>
      lockScheduler.run(new Date('2026-09-08T18:01:00Z'), [company.company.id]),
    );

    const command = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.findFirst({
        where: { deviceId: device.id, command: CommandType.LOCK_DEVICE },
      }),
    );
    expect(command).not.toBeNull();
  });

  it('téléphone jamais retourné : alerte NOT_RETURNED à l’heure de verrouillage', async () => {
    const company = await seedCompany(ctx);
    const { device } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    await TenantContext.system(() =>
      lockScheduler.run(new Date('2026-09-08T22:01:00+02:00'), [company.company.id]),
    );

    const alert = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findFirst({
        where: { deviceId: device.id, type: 'NOT_RETURNED' },
      }),
    );

    // Ce cas ne produit aucun événement de geofence : il n'est détectable que
    // par l'absence, donc par cette vérification à heure fixe.
    expect(alert).not.toBeNull();
    expect(alert?.title).toContain('non retourné');
  });

  it('session expirée : clôturée et FORCE_LOGOUT émis', async () => {
    const company = await seedCompany(ctx);
    const { device, sessionId } = await openSession(
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      `7${uniqueSuffix().slice(-7)}`,
    );

    await TenantContext.system(() =>
      ctx.prisma.raw.session.update({
        where: { id: sessionId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    await TenantContext.system(() => lockScheduler.run(new Date(), [company.company.id]));

    const [session, command] = await TenantContext.system(() =>
      Promise.all([
        ctx.prisma.raw.session.findUniqueOrThrow({ where: { id: sessionId } }),
        ctx.prisma.raw.deviceCommand.findFirst({
          where: { deviceId: device.id, command: CommandType.FORCE_LOGOUT },
        }),
      ]),
    );

    expect(session.status).toBe(SessionStatus.EXPIRED);
    expect(session.endReason).toBe('EXPIRED');
    expect(command).not.toBeNull();
  });

  it('téléphone muet : une seule alerte, refermée au retour', async () => {
    const company = await seedCompany(ctx);
    const device = await seedDevice(
      ctx,
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
    );

    await TenantContext.system(() =>
      ctx.prisma.raw.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date(Date.now() - 4 * 3600_000) },
      }),
    );

    await TenantContext.system(() => healthMonitor.run(new Date(), [company.company.id]));
    await TenantContext.system(() => healthMonitor.run(new Date(), [company.company.id]));

    let alerts = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findMany({
        where: { deviceId: device.id, type: 'DEVICE_OFFLINE' },
      }),
    );
    // Quatre heures de silence produisent UNE alerte, pas quarante-huit.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe(AlertStatus.OPEN);

    await TenantContext.system(() =>
      ctx.prisma.raw.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      }),
    );
    await TenantContext.system(() => healthMonitor.run(new Date(), [company.company.id]));

    alerts = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findMany({
        where: { deviceId: device.id, type: 'DEVICE_OFFLINE' },
      }),
    );
    expect(alerts[0].status).toBe(AlertStatus.AUTO_CLOSED);
  });

  it('entretien : partitions créées à l’avance, idempotent', async () => {
    const first = await TenantContext.system(() => maintenance.ensurePartitions());
    const second = await TenantContext.system(() => maintenance.ensurePartitions());

    expect(first).toHaveLength(4);
    // Le second appel ne recrée rien : la fonction SQL est idempotente.
    expect(second.every((r) => r.includes('déjà présente'))).toBe(true);

    const partitions = await TenantContext.system(() =>
      ctx.prisma.raw.$queryRaw<Array<{ relname: string }>>`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'location_events'
      `,
    );
    expect(partitions.length).toBeGreaterThanOrEqual(4);
  });

  it('entretien : les commandes périmées passent en EXPIRED', async () => {
    const company = await seedCompany(ctx);
    const device = await seedDevice(
      ctx,
      company,
      `TEL-W${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
    );

    const commands = ctx.app.get(CommandsService);
    const command = await TenantContext.system(() =>
      commands.enqueue({
        companyId: company.company.id,
        deviceId: device.id,
        command: CommandType.SYNC_SETTINGS,
        ttlMinutes: 1,
      }),
    );

    await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.update({
        where: { id: command.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    await TenantContext.system(() => maintenance.expireCommands());

    const refreshed = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.findUniqueOrThrow({ where: { id: command.id } }),
    );
    expect(refreshed.status).toBe(CommandStatus.EXPIRED);
  });

  /**
   * Rétention des positions en multi-tenant.
   *
   * La suppression de partition est globale : elle ne peut couper qu'au-delà de
   * la durée la plus longue demandée par une entreprise du parc. Avec un seul
   * client, cela suffit. Avec cent cinquante, une entreprise qui demande un an
   * imposerait un an à toutes les autres — leur rétention annoncée aux salariés
   * ne serait pas tenue, et le disque suivrait la plus gourmande.
   */
  describe('entretien : rétention des positions', () => {
    async function poserPosition(
      companyId: string,
      deviceId: string,
      jours: number,
    ): Promise<void> {
      await TenantContext.system(() =>
        ctx.prisma.raw.locationEvent.create({
          data: {
            id: randomUUID(),
            eventId: randomUUID(),
            companyId,
            deviceId,
            recordedAt: new Date(Date.now() - jours * 86_400_000),
            latitude: 43.3,
            longitude: 5.4,
          },
        }),
      );
    }

    async function compterPositions(companyId: string): Promise<number> {
      return TenantContext.system(() =>
        ctx.prisma.raw.locationEvent.count({ where: { companyId } }),
      );
    }

    it('efface les positions d’une entreprise plus stricte que le parc', async () => {
      // Les partitions doivent exister : sans elles les insertions tombent dans
      // la partition par défaut et le test ne prouverait rien du cas réel.
      await TenantContext.system(() => maintenance.ensurePartitions());

      const stricte = await seedCompany(ctx);
      const laxiste = await seedCompany(ctx);
      const telStricte = await seedDevice(
        ctx,
        stricte,
        `TEL-S${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      );
      const telLaxiste = await seedDevice(
        ctx,
        laxiste,
        `TEL-L${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      );

      await TenantContext.system(() =>
        ctx.prisma.raw.retentionPolicy.update({
          where: { companyId: stricte.company.id },
          data: { locationEventsDays: 30 },
        }),
      );
      await TenantContext.system(() =>
        ctx.prisma.raw.retentionPolicy.update({
          where: { companyId: laxiste.company.id },
          data: { locationEventsDays: 200 },
        }),
      );

      // Une position de 45 jours : hors rétention pour la stricte (30 jours),
      // dans les clous pour la laxiste (200 jours). Aucune suppression de
      // partition ne peut les distinguer — elles sont dans le même mois.
      await poserPosition(stricte.company.id, telStricte.id, 45);
      await poserPosition(laxiste.company.id, telLaxiste.id, 45);
      // Une position récente de chaque côté : elle doit survivre.
      await poserPosition(stricte.company.id, telStricte.id, 1);
      await poserPosition(laxiste.company.id, telLaxiste.id, 1);

      expect(await compterPositions(stricte.company.id)).toBe(2);
      expect(await compterPositions(laxiste.company.id)).toBe(2);

      const policies = await TenantContext.system(() =>
        ctx.prisma.raw.retentionPolicy.findMany({
          where: {
            companyId: { in: [stricte.company.id, laxiste.company.id] },
          },
        }),
      );
      const supprimees = await TenantContext.system(() =>
        maintenance.purgeLocationsDesEntreprisesPlusStrictes(policies, 200),
      );

      expect(supprimees).toBe(1);
      expect(await compterPositions(stricte.company.id)).toBe(1);
      // Le voisin n'est pas touché : c'est tout l'enjeu du cloisonnement.
      expect(await compterPositions(laxiste.company.id)).toBe(2);
    });

    it('ne fait rien quand tout le monde a la même rétention', async () => {
      // Le cas normal, et il doit être GRATUIT : si la suppression de partition
      // suffit, on ne veut aucune suppression ligne à ligne sur une table de
      // centaines de millions de lignes.
      const a = await seedCompany(ctx);
      const b = await seedCompany(ctx);
      const policies = await TenantContext.system(() =>
        ctx.prisma.raw.retentionPolicy.findMany({
          where: { companyId: { in: [a.company.id, b.company.id] } },
        }),
      );

      expect(policies.every((p) => p.locationEventsDays === 60)).toBe(true);
      expect(
        await TenantContext.system(() =>
          maintenance.purgeLocationsDesEntreprisesPlusStrictes(policies, 60),
        ),
      ).toBe(0);
    });

    it('applique le plafond CNIL de deux mois par défaut', async () => {
      // Le défaut n'est pas un réglage de confort : la CNIL pose deux mois en
      // base active pour la géolocalisation de salariés.
      const company = await seedCompany(ctx);
      const policy = await TenantContext.system(() =>
        ctx.prisma.raw.retentionPolicy.findUniqueOrThrow({
          where: { companyId: company.company.id },
        }),
      );
      expect(policy.locationEventsDays).toBe(60);
    });
  });

});
