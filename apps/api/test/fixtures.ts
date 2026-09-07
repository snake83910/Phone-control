import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  AdminRole,
  Company,
  Depot,
  Device,
  DeviceEnrollmentStatus,
  DeviceState,
  User,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/crypto/token.service';
import { DeviceTokenService } from '../src/auth/device-token.service';
import { BadgesService } from '../src/badges/badges.service';
import { UsersService } from '../src/users/users.service';
import { DepotsService } from '../src/depots/depots.service';
import { RedisService } from '../src/redis/redis.service';
import { newId } from '../src/common/ids';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Socle des tests d'intégration.
 *
 * Choix assumé : les tests créent leurs propres entreprises, avec des slugs
 * uniques, plutôt que de vider la base entre chaque exécution. Deux raisons —
 * ils n'effacent pas le jeu de démonstration du développeur, et ils vérifient
 * au passage que le cloisonnement tient dans une base qui contient déjà
 * d'autres entreprises. Une base vide est un environnement de test trop
 * favorable pour du multi-tenant.
 */

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  redis: RedisService;
  badges: BadgesService;
  users: UsersService;
  depots: DepotsService;
  deviceTokens: DeviceTokenService;
  tokens: TokenService;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    prisma: app.get(PrismaService),
    redis: app.get(RedisService),
    badges: app.get(BadgesService),
    users: app.get(UsersService),
    depots: app.get(DepotsService),
    deviceTokens: app.get(DeviceTokenService),
    tokens: app.get(TokenService),
  };
}

let counter = 0;
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

export interface CompanyFixture {
  company: Company;
  depot: Depot;
  adminEmail: string;
  adminPassword: string;
  adminId: string;
}

export async function seedCompany(
  ctx: TestContext,
  options: {
    returnTime?: string;
    lockTime?: string;
    timezone?: string;
    scheduleOverrides?: Record<string, unknown>;
  } = {},
): Promise<CompanyFixture> {
  const suffix = uniqueSuffix();
  const password = 'TestPassword!2026';

  return TenantContext.system(async () => {
    const company = await ctx.prisma.raw.company.create({
      data: {
        id: newId(),
        name: `Test ${suffix}`,
        slug: `test-${suffix}`,
        settings: { detailedDenialMessages: true },
      },
    });

    await ctx.prisma.raw.retentionPolicy.create({
      data: { companyId: company.id },
    });
    await ctx.prisma.raw.deviceSettings.create({
      data: { id: newId(), companyId: company.id },
    });

    const depot = await ctx.depots.create(company.id, {
      code: `D${suffix}`.slice(0, 30),
      name: `Dépôt ${suffix}`,
      latitude: 43.296482,
      longitude: 5.36978,
      radiusMeters: 250,
      exitHysteresisMeters: 75,
      timezone: options.timezone ?? 'Europe/Paris',
      returnTime: options.returnTime ?? '18:00',
      lockTime: options.lockTime ?? '22:00',
      operationalDayStart: '04:00',
      scheduleOverrides: options.scheduleOverrides ?? {},
    });

    const adminEmail = `admin-${suffix}@test.local`;
    const admin = await ctx.prisma.raw.admin.create({
      data: {
        id: newId(),
        email: adminEmail,
        passwordHash: await ctx.tokens.hashPassword(password),
        firstName: 'Test',
        lastName: 'Admin',
        role: AdminRole.COMPANY_ADMIN,
        companyId: company.id,
        depotScope: [],
      },
    });

    return {
      company,
      depot,
      adminEmail,
      adminPassword: password,
      adminId: admin.id,
    };
  });
}

export async function seedDevice(
  ctx: TestContext,
  fixture: CompanyFixture,
  assetTag: string,
  enrolled = true,
): Promise<Device> {
  return TenantContext.system(() =>
    ctx.prisma.raw.device.create({
      data: {
        id: newId(),
        companyId: fixture.company.id,
        depotId: fixture.depot.id,
        assetTag,
        manufacturer: 'samsung',
        model: 'SM-A165F',
        androidVersion: '14',
        appVersion: '1.0.0',
        enrollmentStatus: enrolled
          ? DeviceEnrollmentStatus.ENROLLED
          : DeviceEnrollmentStatus.PENDING,
        deviceOwnerActive: enrolled,
        state: DeviceState.LOCKED,
        enrolledAt: enrolled ? new Date() : null,
      },
    }),
  );
}

export async function seedDriver(
  ctx: TestContext,
  fixture: CompanyFixture,
  params: {
    firstName: string;
    lastName: string;
    barcode: string;
    devices?: Device[];
  },
): Promise<{ user: User; badgeId: string }> {
  return TenantContext.system(async () => {
    const user = await ctx.users.create({
      companyId: fixture.company.id,
      firstName: params.firstName,
      lastName: params.lastName,
      depotId: fixture.depot.id,
      employeeNumber: `MAT-${uniqueSuffix()}`,
    });

    const badge = await ctx.badges.create({
      companyId: fixture.company.id,
      userId: user.id,
      rawBarcode: params.barcode,
    });

    for (const device of params.devices ?? []) {
      await ctx.users.assignDevice(
        fixture.company.id,
        user.id,
        device.id,
        fixture.adminId,
      );
    }

    return { user, badgeId: badge.id };
  });
}

/** Jeton d'accès d'un appareil enrôlé, pour appeler les routes « appareil ». */
export async function deviceAccessToken(
  ctx: TestContext,
  device: Device,
): Promise<string> {
  const tokens = await TenantContext.system(() =>
    ctx.deviceTokens.issue(device.id, device.companyId),
  );
  return tokens.accessToken;
}

/** Jeton d'accès d'un administrateur, via le vrai parcours de connexion. */
export async function adminAccessToken(
  ctx: TestContext,
  fixture: CompanyFixture,
): Promise<string> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: fixture.adminEmail, password: fixture.adminPassword },
  });
  if (response.statusCode !== 200) {
    throw new Error(
      `Connexion administrateur impossible : ${response.statusCode} ${response.body}`,
    );
  }
  return response.json().accessToken as string;
}

/**
 * Vide les compteurs Redis, pour qu'un test ne subisse pas la limitation de
 * débit déclenchée par le test précédent.
 *
 * Les quotas par appareil sont nommés d'après l'appareil, donc faciles à
 * cibler. Le quota **par badge**, lui, est nommé d'après l'empreinte du
 * code-barres — la même pour toutes les entreprises et pour toutes les
 * exécutions, puisqu'elle ne dépend que de la valeur lue et du poivre serveur.
 *
 * Ne pas l'effacer produit un défaut instructif : deux exécutions de la suite à
 * moins d'une minute d'intervalle partagent le compteur d'un badge, et un test
 * qui scanne trois fois le même numéro échoue à la seconde exécution. Le
 * symptôme se déplace au gré de l'ordre des fichiers, que Jest choisit selon
 * leur taille — ajouter un fichier de test ailleurs suffit à le faire
 * apparaître.
 *
 * On efface donc tous les compteurs par badge. Dans un processus de test,
 * personne d'autre n'en dépend.
 */
export async function resetRateLimits(
  ctx: TestContext,
  deviceId: string,
): Promise<void> {
  await ctx.redis.del(
    `rl:barcode:device:${deviceId}`,
    `fail:barcode:${deviceId}`,
    `lock:barcode:${deviceId}`,
  );

  const badgeKeys = await ctx.redis.client.keys('rl:barcode:badge:*');
  if (badgeKeys.length > 0) await ctx.redis.del(...badgeKeys);
}
