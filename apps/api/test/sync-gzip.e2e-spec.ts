import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
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
 * Lots de synchronisation compressés.
 *
 * Un téléphone qui roule toute la journée accumule des milliers de positions,
 * et ce JSON est très répétitif : les mêmes noms de champs, les mêmes préfixes
 * d'identifiants, des coordonnées voisines. La compression se paie en données
 * mobiles réelles — d'où le seuil de quatre kilo-octets côté application.
 *
 * Ce qui est vérifié ici est la moitié serveur du contrat. Sans elle, activer
 * la compression sur les téléphones casserait la synchronisation de tout le
 * parc, d'un seul coup.
 */
describe('Synchronisation : corps compressés', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let deviceId: string;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    const device = await seedDevice(ctx, company, `TEL-GZ-${uniqueSuffix()}`);
    deviceId = device.id;
    token = await deviceAccessToken(ctx, device);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  /** Un lot assez gros pour que la compression ait un sens. */
  function batch(count: number) {
    return {
      deviceId,
      events: Array.from({ length: count }, (_, index) => ({
        eventId: randomUUID(),
        seq: index + 1,
        kind: 'LOCATION',
        occurredAt: new Date(Date.UTC(2026, 8, 5, 8, 0, index % 60)).toISOString(),
        latitude: 45.75 + index * 0.0001,
        longitude: 4.85 + index * 0.0001,
        accuracyMeters: 12,
        speedMps: 8.3,
        provider: 'fused',
        isMock: false,
        batteryLevel: 80,
      })),
    };
  }

  async function countLocations(): Promise<number> {
    return TenantContext.system(() =>
      ctx.prisma.raw.locationEvent.count({ where: { deviceId } }),
    );
  }

  it('accepte un lot compressé et le traite comme un lot ordinaire', async () => {
    const payload = batch(120);
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));

    // Le gain doit être réel : sans lui, la complexité ne se justifierait pas.
    expect(compressed.length).toBeLessThan(JSON.stringify(payload).length / 4);

    const before = await countLocations();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/events',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: compressed,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ackedEventIds).toHaveLength(120);
    expect(await countLocations()).toBe(before + 120);
  });

  it('accepte toujours un lot non compressé', async () => {
    const before = await countLocations();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/events',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: batch(5),
    });

    expect(response.statusCode).toBe(200);
    expect(await countLocations()).toBe(before + 5);
  });

  it('reste idempotent : un lot compressé rejoué ne duplique rien', async () => {
    const payload = batch(30);
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));

    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/sync/events',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        payload: compressed,
      });

    const before = await countLocations();
    expect((await send()).statusCode).toBe(200);
    const afterFirst = await countLocations();
    expect((await send()).statusCode).toBe(200);

    expect(afterFirst).toBe(before + 30);
    expect(await countLocations()).toBe(afterFirst);
  });

  it('refuse un corps annoncé gzip mais illisible, sans rester suspendu', async () => {
    // Le cas se produit : coupure réseau au milieu d'un envoi. La requête doit
    // échouer franchement pour que le téléphone la rejoue — un délai d'attente
    // côté serveur laisserait la file bloquée pendant des minutes.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/events',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: Buffer.from('ceci n’est pas du gzip'),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});
