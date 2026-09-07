import { AdminRole } from '@prisma/client';
import {
  CompanyFixture,
  TestContext,
  adminAccessToken,
  createTestApp,
  seedCompany,
  seedDevice,
  seedDriver,
  uniqueSuffix,
} from './fixtures';
import { newId } from '../src/common/ids';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Authentification administrateur, RBAC et cloisonnement multi-entreprises.
 *
 * L'exigence §45 — « aucune donnée d'une entreprise ne doit être accessible par
 * une autre » — ne se vérifie pas en lisant le code : elle se vérifie en
 * tentant réellement l'accès croisé sur chaque type de ressource.
 */
describe('Administrateurs : authentification, rôles et cloisonnement', () => {
  let ctx: TestContext;
  let alpha: CompanyFixture;
  let beta: CompanyFixture;

  beforeAll(async () => {
    ctx = await createTestApp();
    alpha = await seedCompany(ctx);
    beta = await seedCompany(ctx);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  // -------------------------------------------------------------------------
  // Authentification
  // -------------------------------------------------------------------------

  it('connexion valide : jetons émis et profil renvoyé', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: alpha.adminEmail, password: alpha.adminPassword },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.admin).toMatchObject({
      email: alpha.adminEmail,
      role: AdminRole.COMPANY_ADMIN,
      companyId: alpha.company.id,
    });
  });

  it('mot de passe erroné et compte inexistant donnent le même message', async () => {
    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: alpha.adminEmail, password: 'MauvaisMotDePasse!1' },
    });
    const unknownAccount = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `absent-${uniqueSuffix()}@test.local`, password: 'MauvaisMotDePasse!1' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    // Une réponse différente transformerait la page de connexion en annuaire
    // des adresses valides.
    expect(wrongPassword.json().message).toBe(unknownAccount.json().message);
  });

  it('rotation du jeton de rafraîchissement : le jeton consommé ne resert pas', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: beta.adminEmail, password: beta.adminPassword },
    });
    const firstRefresh = login.json().refreshToken as string;

    const rotated = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: firstRefresh },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refreshToken).not.toBe(firstRefresh);

    // Réutilisation du jeton déjà consommé : c'est le signal d'un vol.
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: firstRefresh },
    });
    expect(reuse.statusCode).toBe(401);

    // Toute la famille est révoquée, y compris le jeton légitime : mieux vaut
    // une reconnexion qu'une session pillée.
    const legitimate = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.json().refreshToken },
    });
    expect(legitimate.statusCode).toBe(401);
  });

  it('un compte désactivé perd l’accès immédiatement, sans attendre l’expiration', async () => {
    const fixture = await seedCompany(ctx);
    const token = await adminAccessToken(ctx, fixture);

    const before = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    await TenantContext.system(() =>
      ctx.prisma.raw.admin.update({
        where: { id: fixture.adminId },
        data: { status: 'DISABLED' },
      }),
    );

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    // Le jeton est encore valide cryptographiquement : c'est la relecture du
    // compte à chaque requête qui ferme la porte.
    expect(after.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  it('un VIEWER peut lire mais ne peut pas agir', async () => {
    const suffix = uniqueSuffix();
    const email = `viewer-${suffix}@test.local`;
    const password = 'TestPassword!2026';

    await TenantContext.system(async () =>
      ctx.prisma.raw.admin.create({
        data: {
          id: newId(),
          email,
          passwordHash: await ctx.tokens.hashPassword(password),
          firstName: 'Vic',
          lastName: 'Observateur',
          role: AdminRole.VIEWER,
          companyId: alpha.company.id,
          depotScope: [],
        },
      }),
    );

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    const token = login.json().accessToken as string;

    const read = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);

    const write = await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${token}` },
      payload: { assetTag: `TEL-V${suffix}`.slice(0, 20).toUpperCase() },
    });
    expect(write.statusCode).toBe(403);
  });

  it('révoquer un téléphone est réservé aux administrateurs d’entreprise', async () => {
    const device = await seedDevice(ctx, alpha, `TEL-R${uniqueSuffix()}`.slice(0, 20).toUpperCase());
    const suffix = uniqueSuffix();
    const email = `depot-${suffix}@test.local`;
    const password = 'TestPassword!2026';

    await TenantContext.system(async () =>
      ctx.prisma.raw.admin.create({
        data: {
          id: newId(),
          email,
          passwordHash: await ctx.tokens.hashPassword(password),
          firstName: 'Denis',
          lastName: 'Dépôt',
          role: AdminRole.DEPOT_ADMIN,
          companyId: alpha.company.id,
          depotScope: [alpha.depot.id],
        },
      }),
    );

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    const token = login.json().accessToken as string;

    // Un responsable de dépôt peut commander un verrouillage...
    const command = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.id}/commands`,
      headers: { authorization: `Bearer ${token}` },
      payload: { command: 'LOCK_DEVICE' },
    });
    expect(command.statusCode).toBe(201);

    // ...mais pas sortir un téléphone de la flotte.
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.id}/revoke`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Cloisonnement multi-entreprises
  // -------------------------------------------------------------------------

  it('les listes ne contiennent que les données de l’entreprise active', async () => {
    await seedDevice(ctx, alpha, `TEL-A${uniqueSuffix()}`.slice(0, 20).toUpperCase());
    await seedDevice(ctx, beta, `TEL-B${uniqueSuffix()}`.slice(0, 20).toUpperCase());

    const token = await adminAccessToken(ctx, alpha);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices?take=200',
      headers: { authorization: `Bearer ${token}` },
    });

    const items = res.json().items as Array<{ id: string }>;
    const betaDevices = await TenantContext.system(() =>
      ctx.prisma.raw.device.findMany({
        where: { companyId: beta.company.id },
        select: { id: true },
      }),
    );
    const betaIds = new Set(betaDevices.map((d) => d.id));

    expect(items.length).toBeGreaterThan(0);
    expect(items.some((d) => betaIds.has(d.id))).toBe(false);
  });

  it.each([
    ['téléphone', (id: string) => `/v1/devices/${id}`],
    ['chauffeur', (id: string) => `/v1/users/${id}`],
    ['dépôt', (id: string) => `/v1/depots/${id}`],
  ])(
    'accès direct par identifiant à un %s d’une autre entreprise : introuvable',
    async (_label, path) => {
      const token = await adminAccessToken(ctx, alpha);

      const device = await seedDevice(
        ctx,
        beta,
        `TEL-X${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
      );
      const { user } = await seedDriver(ctx, beta, {
        firstName: 'Paul',
        lastName: 'Étranger',
        barcode: `6${uniqueSuffix().slice(-7)}`,
      });

      const ids: Record<string, string> = {
        '/v1/devices/': device.id,
        '/v1/users/': user.id,
        '/v1/depots/': beta.depot.id,
      };
      const prefix = Object.keys(ids).find((p) => path('x').startsWith(p))!;

      const res = await ctx.app.inject({
        method: 'GET',
        url: path(ids[prefix]),
        headers: { authorization: `Bearer ${token}` },
      });

      // 404 et non 403 : répondre « cet objet existe, mais pas chez vous »
      // serait déjà une fuite d'information.
      expect(res.statusCode).toBe(404);
    },
  );

  it('créer une ressource pour une autre entreprise est impossible', async () => {
    const token = await adminAccessToken(ctx, alpha);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        firstName: 'Intrus',
        lastName: 'Test',
        depotId: beta.depot.id,
      },
    });

    // Le dépôt appartient à l'autre entreprise : la clé étrangère est refusée
    // parce que le filtre d'entreprise s'applique même à la création.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('agir sur un téléphone d’une autre entreprise est impossible', async () => {
    const token = await adminAccessToken(ctx, alpha);
    const device = await seedDevice(
      ctx,
      beta,
      `TEL-Y${uniqueSuffix()}`.slice(0, 20).toUpperCase(),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.id}/commands`,
      headers: { authorization: `Bearer ${token}` },
      payload: { command: 'LOCK_DEVICE' },
    });

    expect(res.statusCode).toBe(404);

    const commands = await TenantContext.system(() =>
      ctx.prisma.raw.deviceCommand.count({ where: { deviceId: device.id } }),
    );
    expect(commands).toBe(0);
  });

  it('les alertes d’une autre entreprise sont invisibles', async () => {
    await TenantContext.system(() =>
      ctx.prisma.raw.alert.create({
        data: {
          id: newId(),
          companyId: beta.company.id,
          type: 'DEVICE_OFFLINE',
          severity: 'MEDIUM',
          title: 'Alerte entreprise B',
          message: 'Ne doit jamais apparaître chez A.',
        },
      }),
    );

    const token = await adminAccessToken(ctx, alpha);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/alerts?take=200',
      headers: { authorization: `Bearer ${token}` },
    });

    const titles = (res.json().items as Array<{ title: string }>).map((a) => a.title);
    expect(titles).not.toContain('Alerte entreprise B');
  });

  // -------------------------------------------------------------------------
  // Journal d'audit
  // -------------------------------------------------------------------------

  it('les actions administratives sont journalisées, et le journal est immuable', async () => {
    const token = await adminAccessToken(ctx, alpha);
    const assetTag = `TEL-J${uniqueSuffix()}`.slice(0, 20).toUpperCase();

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${token}` },
      payload: { assetTag },
    });
    expect(created.statusCode).toBe(201);

    const entry = await TenantContext.system(() =>
      ctx.prisma.raw.auditLog.findFirst({
        where: {
          companyId: alpha.company.id,
          action: 'ADMIN_CREATE_DEVICE',
          resourceId: created.json().id,
        },
      }),
    );
    expect(entry).not.toBeNull();
    expect(entry?.adminId).toBe(alpha.adminId);
    expect(entry?.correlationId).toBeTruthy();

    // Le trigger PostgreSQL refuse toute modification : un journal d'audit
    // modifiable par l'application ne prouve rien.
    await expect(
      TenantContext.system(() =>
        ctx.prisma.raw.auditLog.update({
          where: { id: entry!.id },
          data: { action: 'FALSIFIÉ' },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      TenantContext.system(() =>
        ctx.prisma.raw.auditLog.delete({ where: { id: entry!.id } }),
      ),
    ).rejects.toThrow();
  });
});
