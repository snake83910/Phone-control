import {
  CompanyFixture,
  TestContext,
  adminAccessToken,
  createTestApp,
  deviceAccessToken,
  seedCompany,
  seedDevice,
  uniqueSuffix,
} from './fixtures';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Blocage d'applications, de bout en bout.
 *
 * Deux moitiés qu'il ne faut pas confondre, et c'est tout l'objet de ces
 * tests :
 *
 * - l'administrateur exprime une **intention** (`PUT /v1/settings/apps`) ;
 * - le téléphone rapporte un **constat** (`POST /v1/devices/app-policy/report`).
 *
 * Les deux sont stockés séparément. Un système qui les confondrait afficherait
 * « bloquée » pour une application parfaitement ouvrable — sur un téléphone
 * sans Device Owner, c'est même le cas général.
 */
describe('Politique d’applications', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    adminToken = await adminAccessToken(ctx, company);
  }, 60_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  async function putPolicy(
    body: { allowedApps: string[]; blockedApps: string[] },
    token = adminToken,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/settings/apps',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
    return { status: response.statusCode, body: response.json() };
  }

  describe('intention : ce que l’administrateur demande', () => {
    it('enregistre une application à bloquer', async () => {
      const { status, body } = await putPolicy({
        allowedApps: [],
        blockedApps: ['com.supercell.clashofclans'],
      });

      expect(status).toBe(200);
      expect(body.blockedApps).toEqual(['com.supercell.clashofclans']);
    });

    it('incrémente la version, sans quoi la politique ne partirait jamais', async () => {
      // Le téléphone ne retélécharge sa configuration que si la version a
      // changé. Une politique enregistrée sans incrément resterait en base sans
      // jamais atteindre un seul appareil — panne silencieuse par excellence.
      const avant = await putPolicy({ allowedApps: [], blockedApps: [] });
      const apres = await putPolicy({
        allowedApps: [],
        blockedApps: ['com.exemple.jeu'],
      });

      expect(apres.body.version as number).toBeGreaterThan(
        avant.body.version as number,
      );
    });

    it('remplace la liste au lieu de la fusionner', async () => {
      // C'est ce qui rend un blocage erroné réparable depuis le tableau de bord.
      // Une fusion obligerait à passer par chaque téléphone.
      await putPolicy({ allowedApps: [], blockedApps: ['com.exemple.un'] });
      const { body } = await putPolicy({
        allowedApps: [],
        blockedApps: ['com.exemple.deux'],
      });

      expect(body.blockedApps).toEqual(['com.exemple.deux']);
    });

    it('refuse de bloquer un paquet système', async () => {
      const { status, body } = await putPolicy({
        allowedApps: [],
        blockedApps: ['com.android.systemui'],
      });

      expect(status).toBe(400);
      expect(String(body.message)).toContain('com.android.systemui');
    });

    it('refuse de bloquer les services Google Play', async () => {
      // Ils portent la notification qui achemine les commandes à distance :
      // les masquer supprimerait le moyen d'annuler la manœuvre.
      const { status } = await putPolicy({
        allowedApps: [],
        blockedApps: ['com.google.android.gms'],
      });

      expect(status).toBe(400);
    });

    it('refuse un nom d’application au lieu d’un nom de paquet', async () => {
      // Erreur de saisie la plus probable, et la plus trompeuse : acceptée, elle
      // produirait une politique qui ne désigne rien et un administrateur
      // convaincu d'avoir bloqué Facebook.
      const { status, body } = await putPolicy({
        allowedApps: [],
        blockedApps: ['Facebook'],
      });

      expect(status).toBe(400);
      expect(String(body.message)).toContain('nom de paquet');
    });

    it('absorbe les doublons et les lignes vides', async () => {
      const { body } = await putPolicy({
        allowedApps: [],
        blockedApps: ['com.exemple.jeu', '  com.exemple.jeu  ', '', '   '],
      });

      expect(body.blockedApps).toEqual(['com.exemple.jeu']);
    });

    it('relit ce qui a été écrit', async () => {
      await putPolicy({
        allowedApps: ['com.google.android.apps.maps'],
        blockedApps: ['com.exemple.jeu'],
      });

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/settings/apps',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().allowedApps).toEqual([
        'com.google.android.apps.maps',
      ]);
      expect(response.json().blockedApps).toEqual(['com.exemple.jeu']);
    });

    it('n’expose pas la politique d’une autre entreprise', async () => {
      // §45 : l'isolation ne se vérifie pas par relecture du code, elle se
      // teste.
      const autre = await seedCompany(ctx);
      const autreToken = await adminAccessToken(ctx, autre);

      await putPolicy({ allowedApps: [], blockedApps: ['com.exemple.prive'] });

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/settings/apps',
        headers: { authorization: `Bearer ${autreToken}` },
      });

      expect(response.json().blockedApps).toEqual([]);
    });
  });

  describe('transmission : la politique atteint le téléphone', () => {
    it('part dans la synchronisation quand la version a changé', async () => {
      const device = await seedDevice(ctx, company, `SYNC-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      await putPolicy({
        allowedApps: ['com.google.android.apps.maps'],
        blockedApps: ['com.exemple.jeu'],
      });

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/sync/pull',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().settings.blockedApps).toEqual(['com.exemple.jeu']);
      expect(response.json().settings.allowedApps).toEqual([
        'com.google.android.apps.maps',
      ]);
    });
  });

  describe('constat : ce que le téléphone a réellement fait', () => {
    it('enregistre un constat d’application', async () => {
      const device = await seedDevice(ctx, company, `RPT-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/app-policy/report',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: device.id,
          enforced: true,
          configVersion: 3,
          hidden: ['com.exemple.jeu'],
          refusals: [],
        },
      });

      expect(response.statusCode).toBe(200);

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.device.findUnique({ where: { id: device.id } }),
      );
      expect(stored?.appPolicyReport).toMatchObject({
        enforced: true,
        hidden: ['com.exemple.jeu'],
      });
      expect(stored?.appPolicyAppliedAt).toBeInstanceOf(Date);
    });

    it('distingue « rien à bloquer » de « blocage impossible »', async () => {
      // Les deux produisent une liste vide. Sans le drapeau, le tableau de bord
      // afficherait la même chose pour un téléphone conforme et pour un
      // téléphone où aucune protection n'est active (§67).
      const device = await seedDevice(ctx, company, `NODO-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/app-policy/report',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: device.id,
          enforced: false,
          configVersion: 3,
          hidden: [],
          refusals: [],
        },
      });

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.device.findUnique({ where: { id: device.id } }),
      );
      expect((stored?.appPolicyReport as { enforced: boolean }).enforced).toBe(
        false,
      );
    });

    it('conserve les refus motivés', async () => {
      const device = await seedDevice(ctx, company, `REF-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/app-policy/report',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: device.id,
          enforced: true,
          configVersion: 3,
          hidden: [],
          refusals: [
            { packageName: 'com.faceboook.katana', reason: 'NOT_INSTALLED' },
          ],
        },
      });

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.device.findUnique({ where: { id: device.id } }),
      );
      expect(
        (stored?.appPolicyReport as { refusals: unknown[] }).refusals,
      ).toEqual([
        { packageName: 'com.faceboook.katana', reason: 'NOT_INSTALLED' },
      ]);
    });

    it('refuse un motif inconnu', async () => {
      // Le vocabulaire des refus est partagé entre le téléphone, le serveur et
      // le tableau de bord. Accepter n'importe quelle chaîne ferait afficher un
      // motif que personne ne sait traduire.
      const device = await seedDevice(ctx, company, `BAD-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/app-policy/report',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: device.id,
          enforced: true,
          configVersion: 3,
          hidden: [],
          refusals: [{ packageName: 'a.b', reason: 'PARCE_QUE' }],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuse un constat portant sur un autre appareil', async () => {
      const device = await seedDevice(ctx, company, `SELF-${uniqueSuffix()}`);
      const autre = await seedDevice(ctx, company, `OTHR-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices/app-policy/report',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          deviceId: autre.id,
          enforced: true,
          configVersion: 3,
          hidden: [],
          refusals: [],
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
