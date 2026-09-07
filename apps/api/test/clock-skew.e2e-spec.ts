import { randomUUID } from 'node:crypto';
import { AlertType, SecurityEventType } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  createTestApp,
  deviceAccessToken,
  seedCompany,
  seedDevice,
  uniqueSuffix,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Horloge de l'appareil.
 *
 * Les règles horaires du dépôt — retour à 18 h, verrouillage à 22 h — reposent
 * sur une heure. Un téléphone dont l'horloge a été reculée y échapperait, et
 * n'aurait évidemment aucune raison de le déclarer lui-même. C'est donc au
 * serveur, qui détient l'heure de référence, de le voir.
 *
 * La règle est celle de docs/05 : **accepté, mais marqué**. Rejeter un
 * événement mal daté reviendrait à effacer ce qu'on cherche à constater.
 */
describe('Synchronisation : horloge incohérente', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let deviceId: string;
  let assetTag: string;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    assetTag = `TEL-CLK-${uniqueSuffix()}`;
    const device = await seedDevice(ctx, company, assetTag);
    deviceId = device.id;
    token = await deviceAccessToken(ctx, device);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  function locationAt(occurredAt: Date) {
    return {
      eventId: randomUUID(),
      seq: 1,
      kind: 'LOCATION' as const,
      occurredAt: occurredAt.toISOString(),
      latitude: 45.75,
      longitude: 4.85,
      accuracyMeters: 10,
    };
  }

  async function push(events: unknown[]): Promise<number> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { deviceId, events },
    });
    return response.statusCode;
  }

  async function suspectCount(): Promise<number> {
    return TenantContext.system(() =>
      ctx.prisma.raw.locationEvent.count({ where: { deviceId, clockSuspect: true } }),
    );
  }

  it('accepte une position datée dans le futur et la marque', async () => {
    // Une heure d'avance : bien au-delà de la tolérance de cinq minutes.
    const before = await suspectCount();
    expect(await push([locationAt(new Date(Date.now() + 3_600_000))])).toBe(200);

    expect(await suspectCount()).toBe(before + 1);
  });

  it('ne marque pas une position datée normalement', async () => {
    const before = await suspectCount();
    expect(await push([locationAt(new Date(Date.now() - 30_000))])).toBe(200);

    expect(await suspectCount()).toBe(before);
  });

  it('tolère la petite dérive ordinaire des téléphones', async () => {
    // Deux minutes d'avance : une horloge non synchronisée, pas une fraude.
    const before = await suspectCount();
    expect(await push([locationAt(new Date(Date.now() + 120_000))])).toBe(200);

    expect(await suspectCount()).toBe(before);
  });

  it('remonte un événement de sécurité CLOCK_TAMPERING', async () => {
    await push([locationAt(new Date(Date.now() + 7_200_000))]);

    const events = await TenantContext.system(() =>
      ctx.prisma.raw.securityEvent.findMany({
        where: { deviceId, type: SecurityEventType.CLOCK_TAMPERING },
        orderBy: { occurredAt: 'desc' },
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    expect((events[0].metadata as { aheadByMinutes?: number }).aheadByMinutes)
      .toBeGreaterThanOrEqual(115);
  });

  it('ne crée qu’une alerte, même après plusieurs lots', async () => {
    // Un téléphone à l'horloge faussée synchronise toutes les quinze minutes :
    // sans déduplication, quatre-vingt-seize alertes par jour, que personne ne
    // lira.
    await push([locationAt(new Date(Date.now() + 3_600_000))]);
    await push([locationAt(new Date(Date.now() + 3_600_000))]);

    const alerts = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findMany({
        where: { deviceId, type: AlertType.DEVICE_TAMPERING },
      }),
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain('Horloge');
  });

  it('marque aussi un événement de sécurité daté dans le futur', async () => {
    const eventId = randomUUID();
    expect(
      await push([
        {
          eventId,
          seq: 2,
          kind: 'SECURITY',
          occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
          securityType: SecurityEventType.ADB_ENABLED,
          severity: 'MEDIUM',
        },
      ]),
    ).toBe(200);

    const stored = await TenantContext.system(() =>
      ctx.prisma.raw.securityEvent.findUnique({ where: { eventId } }),
    );

    expect(stored?.clockSuspect).toBe(true);
  });
});
