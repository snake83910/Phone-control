import { BadgeStatus, SessionStatus, UserStatus } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  adminAccessToken,
  createTestApp,
  deviceAccessToken,
  resetRateLimits,
  seedCompany,
  seedDevice,
  seedDriver,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Tests d'intégration du scan de badge — scénarios 1 à 3 de la section 59 de
 * la spécification, plus les cas de sécurité qui s'y rattachent.
 *
 * Le badge 14557719 (Rémy Simon) est celui fourni pour les essais.
 */
describe('POST /v1/auth/barcode', () => {
  let ctx: TestContext;
  let company: CompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  async function scan(
    token: string,
    deviceId: string,
    barcode: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      headers: { authorization: `Bearer ${token}` },
      payload: { barcode, deviceId },
    });
    return { status: res.statusCode, body: res.json() };
  }

  // -------------------------------------------------------------------------

  it('TEST 1 — badge valide sur un téléphone autorisé : ACCÈS AUTORISÉ', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T1');
    const { user } = await seedDriver(ctx, company, {
      firstName: 'Rémy',
      lastName: 'Simon',
      barcode: '14557719',
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);

    const { status, body } = await scan(token, device.id, '14557719');

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.user).toMatchObject({
      id: user.id,
      firstName: 'Rémy',
      lastName: 'Simon',
    });
    expect(body.session).toHaveProperty('id');
    expect(body.session).toHaveProperty('expiresAt');

    const session = await TenantContext.system(() =>
      ctx.prisma.raw.session.findFirst({
        where: { deviceId: device.id, status: SessionStatus.ACTIVE },
      }),
    );
    expect(session?.userId).toBe(user.id);

    // L'état de l'appareil suit la session : le dashboard doit le voir actif.
    const refreshed = await TenantContext.system(() =>
      ctx.prisma.raw.device.findUniqueOrThrow({ where: { id: device.id } }),
    );
    expect(refreshed.state).toBe('ACTIVE');
  });

  it('TEST 2 — badge inconnu : ACCÈS REFUSÉ, tracé et alerté', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T2');
    const token = await deviceAccessToken(ctx, device);

    const { status, body } = await scan(token, device.id, '99999999');

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('BADGE_DENIED');

    const [scanEvent, alert] = await TenantContext.system(() =>
      Promise.all([
        ctx.prisma.raw.barcodeScanEvent.findFirst({
          where: { deviceId: device.id },
          orderBy: { scannedAt: 'desc' },
        }),
        ctx.prisma.raw.alert.findFirst({
          where: { deviceId: device.id, type: 'UNKNOWN_BADGE' },
        }),
      ]),
    );

    expect(scanEvent?.result).toBe('UNKNOWN_BADGE');
    // L'empreinte est conservée pour détecter une énumération...
    expect(scanEvent?.barcodeHash).not.toBeNull();
    // ...mais jamais la valeur, seulement les quatre derniers caractères.
    expect(scanEvent?.barcodeLast4).toBe('9999');
    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe('MEDIUM');
  });

  it('TEST 3 — badge valide, téléphone non affecté, affectation EXIGÉE : REFUS', async () => {
    // L'affectation nominative est désactivée par défaut : un DSP a quarante
    // chauffeurs pour vingt-cinq téléphones pris dans un bac le matin, et
    // l'exiger obligerait à réaffecter la flotte chaque jour. Ce test décrit
    // donc l'option, pas le comportement ordinaire — d'où le réglage explicite.
    await TenantContext.system(() =>
      ctx.prisma.raw.company.update({
        where: { id: company.company.id },
        data: { settings: { requireDeviceAssignment: true } },
      }),
    );

    const allowed = await seedDevice(ctx, company, 'TEL-T3A');
    const forbidden = await seedDevice(ctx, company, 'TEL-T3B');
    await seedDriver(ctx, company, {
      firstName: 'Jean',
      lastName: 'Dupont',
      barcode: '20000001',
      devices: [allowed],
    });
    const token = await deviceAccessToken(ctx, forbidden);

    const { body } = await scan(token, forbidden.id, '20000001');

    expect(body.success).toBe(false);
    expect(body.reason).toBe('DEVICE_NOT_AUTHORIZED');
    expect(body.message).toContain("n'est pas autorisé pour cet utilisateur");

    const session = await TenantContext.system(() =>
      ctx.prisma.raw.session.findFirst({
        where: { deviceId: forbidden.id, status: SessionStatus.ACTIVE },
      }),
    );
    expect(session).toBeNull();

    const alert = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findFirst({
        where: { deviceId: forbidden.id, type: 'UNAUTHORIZED_USER' },
      }),
    );
    expect(alert).not.toBeNull();

    // Remis à l'état par défaut : les tests suivants partagent cette
    // entreprise, et un réglage qui déborde d'un test sur l'autre est la
    // façon la plus pénible de perdre une soirée.
    await TenantContext.system(() =>
      ctx.prisma.raw.company.update({
        where: { id: company.company.id },
        data: { settings: {} },
      }),
    );
  });

  it('TEST 3 bis — par défaut, tout téléphone de l’entreprise accepte le badge', async () => {
    // LE comportement voulu : le chauffeur prend le téléphone qui est libre.
    // Ce qui protège reste entier — même entreprise, badge actif, quotas — et
    // c'est ce que la seconde moitié de ce test vérifie.
    const jamaisAffecte = await seedDevice(ctx, company, 'TEL-T3C');
    await seedDriver(ctx, company, {
      firstName: 'Claire',
      lastName: 'Martin',
      barcode: '20000099',
      devices: [],
    });
    const token = await deviceAccessToken(ctx, jamaisAffecte);

    const { body } = await scan(token, jamaisAffecte.id, '20000099');

    expect(body.success).toBe(true);

    const session = await TenantContext.system(() =>
      ctx.prisma.raw.session.findFirst({
        where: { deviceId: jamaisAffecte.id, status: SessionStatus.ACTIVE },
      }),
    );
    expect(session).not.toBeNull();

    // Aucune alerte : ce n'est plus un incident, c'est le fonctionnement.
    const alert = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findFirst({
        where: { deviceId: jamaisAffecte.id, type: 'UNAUTHORIZED_USER' },
      }),
    );
    expect(alert).toBeNull();
  });

  it('badge révoqué : refusé, sans révéler que le badge existe', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T4');
    const { badgeId } = await seedDriver(ctx, company, {
      firstName: 'Marc',
      lastName: 'Martin',
      barcode: '20000002',
      devices: [device],
    });
    await TenantContext.system(() =>
      ctx.prisma.raw.badge.update({
        where: { id: badgeId },
        data: { status: BadgeStatus.REVOKED, revokedAt: new Date() },
      }),
    );
    const token = await deviceAccessToken(ctx, device);

    const { body } = await scan(token, device.id, '20000002');

    expect(body.success).toBe(false);
    // Même motif qu'un badge inconnu : l'écran de scan ne doit pas devenir un
    // oracle permettant de distinguer « inexistant » de « révoqué ».
    expect(body.reason).toBe('BADGE_DENIED');
  });

  it('utilisateur désactivé : refusé même avec un badge actif', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T5');
    const { user } = await seedDriver(ctx, company, {
      firstName: 'Luc',
      lastName: 'Bernard',
      barcode: '20000003',
      devices: [device],
    });
    await TenantContext.system(() =>
      ctx.prisma.raw.user.update({
        where: { id: user.id },
        data: { status: UserStatus.INACTIVE },
      }),
    );
    const token = await deviceAccessToken(ctx, device);

    const { body } = await scan(token, device.id, '20000003');
    expect(body.success).toBe(false);
    expect(body.reason).toBe('BADGE_DENIED');
  });

  it('un nouveau scan remplace la session précédente', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T6');
    const first = await seedDriver(ctx, company, {
      firstName: 'Alice',
      lastName: 'Durand',
      barcode: '20000004',
      devices: [device],
    });
    const second = await seedDriver(ctx, company, {
      firstName: 'Bob',
      lastName: 'Leroy',
      barcode: '20000005',
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);

    const firstScan = await scan(token, device.id, '20000004');
    expect(firstScan.body.success).toBe(true);
    const firstSessionId = (firstScan.body.session as { id: string }).id;

    const secondScan = await scan(token, device.id, '20000005');
    expect(secondScan.body.success).toBe(true);

    const sessions = await TenantContext.system(() =>
      ctx.prisma.raw.session.findMany({
        where: { deviceId: device.id },
        orderBy: { startedAt: 'asc' },
      }),
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(firstSessionId);
    expect(sessions[0].status).toBe(SessionStatus.ENDED);
    expect(sessions[0].endReason).toBe('NEW_SESSION');
    expect(sessions[0].userId).toBe(first.user.id);
    expect(sessions[1].status).toBe(SessionStatus.ACTIVE);
    expect(sessions[1].userId).toBe(second.user.id);
  });

  it('formats de lecture tolérés : espaces et tirets donnent le même badge', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T7');
    await seedDriver(ctx, company, {
      firstName: 'Nadia',
      lastName: 'Perrin',
      barcode: '20000006',
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);

    for (const variant of [' 20000006 ', '2000-0006', '20 00 00 06']) {
      await resetRateLimits(ctx, device.id);
      const { body } = await scan(token, device.id, variant);
      expect(body.success).toBe(true);
    }
  });

  it('les zéros de tête sont significatifs : 020000006 n’est pas 20000006', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T8');
    await seedDriver(ctx, company, {
      firstName: 'Yves',
      lastName: 'Marchand',
      barcode: '20000007',
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);

    const { body } = await scan(token, device.id, '020000007');
    expect(body.success).toBe(false);
  });

  it('cloisonnement : un badge d’une autre entreprise est inconnu ici', async () => {
    // Les deux entreprises utilisent VOLONTAIREMENT le même numéro de badge.
    const other = await seedCompany(ctx);
    const otherDevice = await seedDevice(ctx, other, 'TEL-X1');
    await seedDriver(ctx, other, {
      firstName: 'Paul',
      lastName: 'Étranger',
      barcode: '30000001',
      devices: [otherDevice],
    });

    const device = await seedDevice(ctx, company, 'TEL-T9');
    await seedDriver(ctx, company, {
      firstName: 'Sophie',
      lastName: 'Girard',
      barcode: '30000001',
      devices: [device],
    });

    const token = await deviceAccessToken(ctx, device);
    const { body } = await scan(token, device.id, '30000001');

    // Le scan aboutit, mais sur la chauffeuse de CETTE entreprise.
    expect(body.success).toBe(true);
    expect(body.user).toMatchObject({ firstName: 'Sophie', lastName: 'Girard' });
  });

  it('la charge utile ne peut pas désigner un autre appareil que le jeton', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T10');
    const otherDevice = await seedDevice(ctx, company, 'TEL-T11');
    const token = await deviceAccessToken(ctx, device);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      headers: { authorization: `Bearer ${token}` },
      payload: { barcode: '14557719', deviceId: otherDevice.id },
    });

    expect(res.statusCode).toBe(403);
  });

  it('sans jeton d’appareil, la route est fermée', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      payload: { barcode: '14557719', deviceId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('un jeton d’administrateur ne vaut pas jeton d’appareil', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T12');
    const adminToken = await adminAccessToken(ctx, company);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { barcode: '14557719', deviceId: device.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it('limitation de débit : les scans répétés finissent par être bloqués', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T13');
    const token = await deviceAccessToken(ctx, device);
    await resetRateLimits(ctx, device.id);

    const results: string[] = [];
    for (let i = 0; i < 14; i++) {
      const { body } = await scan(token, device.id, `4000000${i}`);
      results.push((body.reason as string) ?? 'OK');
    }

    // Quota par défaut : 10 scans par minute et par appareil.
    expect(results.filter((r) => r === 'RATE_LIMITED').length).toBeGreaterThan(0);
    await resetRateLimits(ctx, device.id);
  });

  it('un appareil révoqué ne peut plus authentifier personne', async () => {
    const device = await seedDevice(ctx, company, 'TEL-T14');
    await seedDriver(ctx, company, {
      firstName: 'Théo',
      lastName: 'Blanc',
      barcode: '20000008',
      devices: [device],
    });
    const token = await deviceAccessToken(ctx, device);

    await TenantContext.system(() =>
      ctx.prisma.raw.device.update({
        where: { id: device.id },
        data: { enrollmentStatus: 'REVOKED', revokedAt: new Date() },
      }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/barcode',
      headers: { authorization: `Bearer ${token}` },
      payload: { barcode: '20000008', deviceId: device.id },
    });

    // Le guard rejette avant même d'atteindre la logique de scan.
    expect(res.statusCode).toBe(401);
  });
});
