import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
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
import { APK_CONTENT_TYPE } from '../src/app-packages/apk-upload';

/**
 * Dépôt et déploiement d'applications.
 *
 * Ces tests portent sur la fonction la plus dangereuse du système : « installe
 * l'APK qui se trouve là » est une exécution de code arbitraire sur la flotte
 * entière. Ils vérifient donc surtout ce qui est **refusé**, et le fait que les
 * empreintes soient calculées par le serveur plutôt que déclarées par celui qui
 * dépose le fichier.
 *
 * L'APK utilisé est celui du projet lui-même, construit par Gradle. À défaut,
 * la suite est ignorée plutôt que de vérifier une contrefaçon : un faux APK ne
 * dirait rien de la lecture d'un vrai bloc de signature.
 */
const APK_PATH = resolve(
  __dirname,
  '../../android/app/build/outputs/apk/debug/app-debug.apk',
);

const apk = (() => {
  try {
    return readFileSync(APK_PATH);
  } catch {
    return null;
  }
})();

const describeIfApk = apk ? describe : describe.skip;

describeIfApk('Dépôt et déploiement d’applications', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let adminToken: string;
  let storageDir: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    adminToken = await adminAccessToken(ctx, company);

    const config = ctx.app.get(ConfigService);
    const configured = config.get<string>(
      'APP_PACKAGE_STORAGE_DIR',
      './storage/app-packages',
    );
    storageDir = resolve(process.cwd(), configured);
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
  });

  async function upload(
    body: Buffer,
    label = `Test ${uniqueSuffix()}`,
    token = adminToken,
  ) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v1/app-packages?label=${encodeURIComponent(label)}`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': APK_CONTENT_TYPE,
      },
      payload: body,
    });
    return { status: response.statusCode, body: response.json() };
  }

  describe('le dépôt', () => {
    it('accepte un APK et en calcule lui-même les empreintes', async () => {
      const { status, body } = await upload(apk!);

      expect(status).toBe(201);
      // L'empreinte n'est jamais saisie : une empreinte fournie par celui qui
      // dépose le fichier décrirait le fichier déposé, quel qu'il soit.
      expect(body.sha256).toBe(createHash('sha256').update(apk!).digest('hex'));
      expect(String(body.signingCertSha256)).toHaveLength(43);
      expect(body.sizeBytes).toBe(apk!.length);
    });

    it('rapporte le certificat de signature du fichier déposé', async () => {
      const { body } = await upload(apk!);

      // L'opérateur a le droit de savoir ce qu'il vient de déposer, avant de
      // l'envoyer sur deux mille téléphones.
      expect(body.certificate).toBeDefined();
      expect(String(body.certificate.subject).length).toBeGreaterThan(0);
    });

    it('refuse un fichier qui n’est pas un APK signé', async () => {
      const { status, body } = await upload(
        Buffer.from('ceci n’est pas un APK'),
      );

      expect(status).toBe(400);
      expect(String(body.message)).toContain('APK');
    });

    it('ne laisse aucun fichier derrière un dépôt refusé', async () => {
      // Un APK tronqué qui resterait sur disque finirait un jour par être servi
      // à un téléphone.
      const before = await readdir(storageDir).catch(() => []);
      await upload(Buffer.from('rejeté'));
      const after = await readdir(storageDir).catch(() => []);

      expect(after.length).toBe(before.length);
    });

    it('refuse un corps vide', async () => {
      const { status } = await upload(Buffer.alloc(0));
      expect(status).toBe(400);
    });

    it('exige un nom lisible', async () => {
      const { status, body } = await upload(apk!, 'x');
      expect(status).toBe(400);
      expect(String(body.message)).toContain('nom');
    });
  });

  describe('le déploiement', () => {
    it('émet une commande portant les deux empreintes', async () => {
      const device = await seedDevice(ctx, company, `APK-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);
      const { body: pkg } = await upload(apk!);

      const deployed = await ctx.app.inject({
        method: 'POST',
        url: `/v1/app-packages/${pkg.id as string}/deploy`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { deviceIds: [device.id] },
      });
      expect(deployed.statusCode).toBe(200);
      expect(deployed.json().queued).toBe(1);

      const commands = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices/commands',
        headers: { authorization: `Bearer ${token}` },
      });

      const install = (
        commands.json() as Array<{ command: string; payload: Record<string, unknown> }>
      ).find((c) => c.command === 'INSTALL_APP');

      expect(install).toBeDefined();
      // Sans ces deux valeurs, le téléphone n'aurait rien à vérifier : il
      // installerait ce qu'on lui envoie.
      expect(install!.payload.sha256).toBe(pkg.sha256);
      expect(install!.payload.signingCertSha256).toBe(pkg.signingCertSha256);
    });

    it('ne produit qu’une commande si la même application est poussée deux fois', async () => {
      const device = await seedDevice(ctx, company, `DUP-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);
      const { body: pkg } = await upload(apk!);

      const deploy = () =>
        ctx.app.inject({
          method: 'POST',
          url: `/v1/app-packages/${pkg.id as string}/deploy`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { deviceIds: [device.id] },
        });

      await deploy();
      await deploy();

      const commands = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices/commands',
        headers: { authorization: `Bearer ${token}` },
      });

      const installs = (
        commands.json() as Array<{ command: string }>
      ).filter((c) => c.command === 'INSTALL_APP');
      expect(installs).toHaveLength(1);
    });

    it('vise toute la flotte enrôlée quand aucun téléphone n’est désigné', async () => {
      // Le tableau de bord ne peut pas énumérer deux mille identifiants : c'est
      // le serveur qui résout la cible. Un appareil non enrôlé en est exclu —
      // lui envoyer une commande qu'il ne recevra jamais ne ferait qu'encombrer
      // la file.
      const enrolled = await seedDevice(ctx, company, `FLT-${uniqueSuffix()}`);
      const pending = await seedDevice(
        ctx,
        company,
        `PND-${uniqueSuffix()}`,
        false,
      );
      const { body: pkg } = await upload(apk!);

      const deployed = await ctx.app.inject({
        method: 'POST',
        url: `/v1/app-packages/${pkg.id as string}/deploy`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });

      expect(deployed.statusCode).toBe(200);

      const commands = await TenantContext.system(() =>
        ctx.prisma.raw.deviceCommand.findMany({
          where: { command: 'INSTALL_APP', deviceId: { in: [enrolled.id, pending.id] } },
        }),
      );

      expect(commands.map((c) => c.deviceId)).toEqual([enrolled.id]);
    });

    it('refuse de déployer une application retirée', async () => {
      const device = await seedDevice(ctx, company, `RET-${uniqueSuffix()}`);
      const { body: pkg } = await upload(apk!);

      await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/app-packages/${pkg.id as string}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const deployed = await ctx.app.inject({
        method: 'POST',
        url: `/v1/app-packages/${pkg.id as string}/deploy`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { deviceIds: [device.id] },
      });

      expect(deployed.statusCode).toBe(400);
    });
  });

  describe('le téléchargement', () => {
    it('sert le fichier déposé, octet pour octet', async () => {
      const device = await seedDevice(ctx, company, `DL-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);
      const { body: pkg } = await upload(apk!);

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/v1/app-packages/${pkg.id as string}/download`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(
        pkg.sha256,
      );
      expect(response.headers['x-apk-sha256']).toBe(pkg.sha256);
    });

    it('n’est pas accessible sans jeton d’appareil', async () => {
      const { body: pkg } = await upload(apk!);

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/v1/app-packages/${pkg.id as string}/download`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('n’est pas accessible depuis une autre entreprise', async () => {
      // §45 : un APK déposé par une entreprise ne doit pas fuir vers les
      // téléphones d'une autre.
      const autre = await seedCompany(ctx);
      const etranger = await seedDevice(ctx, autre, `OTH-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, etranger);
      const { body: pkg } = await upload(apk!);

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/v1/app-packages/${pkg.id as string}/download`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuse une application retirée', async () => {
      const device = await seedDevice(ctx, company, `GONE-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);
      const { body: pkg } = await upload(apk!);

      await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/app-packages/${pkg.id as string}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/v1/app-packages/${pkg.id as string}/download`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('l’identité rapportée par le téléphone', () => {
    it('enregistre le nom de paquet réellement installé', async () => {
      const device = await seedDevice(ctx, company, `ID-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);
      const { body: pkg } = await upload(apk!);

      await ctx.app.inject({
        method: 'POST',
        url: '/v1/app-packages/installed',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          packageId: pkg.id,
          packageName: 'com.phonecontrol',
          versionName: '1.0.0',
          versionCode: 1,
        },
      });

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.appPackage.findUnique({ where: { id: pkg.id as string } }),
      );
      expect(stored?.packageName).toBe('com.phonecontrol');
      expect(stored?.versionCode).toBe(1);
    });

    it('n’écrase pas une identité déjà connue par une identité divergente', async () => {
      // Deux téléphones qui ne voient pas le même nom de paquet dans le même
      // fichier signalent un problème. L'écrasement silencieux le masquerait.
      const device = await seedDevice(ctx, company, `DIV-${uniqueSuffix()}`);
      const token = await deviceAccessToken(ctx, device);
      const { body: pkg } = await upload(apk!);

      const report = (packageName: string) =>
        ctx.app.inject({
          method: 'POST',
          url: '/v1/app-packages/installed',
          headers: { authorization: `Bearer ${token}` },
          payload: {
            packageId: pkg.id,
            packageName,
            versionName: '1.0.0',
            versionCode: 1,
          },
        });

      await report('com.phonecontrol');
      await report('com.attaquant.paquet');

      const stored = await TenantContext.system(() =>
        ctx.prisma.raw.appPackage.findUnique({ where: { id: pkg.id as string } }),
      );
      expect(stored?.packageName).toBe('com.phonecontrol');
    });
  });

  describe('l’isolation entre entreprises', () => {
    it('ne montre pas les dépôts d’une autre entreprise', async () => {
      const autre = await seedCompany(ctx);
      const autreToken = await adminAccessToken(ctx, autre);
      await upload(apk!);

      const response = await ctx.app.inject({
        method: 'GET',
        url: '/v1/app-packages',
        headers: { authorization: `Bearer ${autreToken}` },
      });

      expect(response.json()).toEqual([]);
    });
  });

  afterAll(async () => {
    // Les APK déposés par les tests pèsent lourd : les laisser s'accumuler
    // remplirait le disque au fil des exécutions.
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
  });
});
