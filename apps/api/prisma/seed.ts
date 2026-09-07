import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  AdminRole,
  CompanyStatus,
  DeviceEnrollmentStatus,
  DeviceState,
  KioskMode,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/crypto/token.service';
import { BadgesService } from '../src/badges/badges.service';
import { UsersService } from '../src/users/users.service';
import { DepotsService } from '../src/depots/depots.service';
import { newId } from '../src/common/ids';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Jeu de données de démonstration.
 *
 * Il passe délibérément par les SERVICES applicatifs et non par des insertions
 * directes : le hachage des badges, le chiffrement, la création du geofence et
 * les valeurs par défaut suivent exactement le chemin de production. Un seed
 * qui écrit en base « à la main » finit toujours par diverger du code réel.
 */
async function main(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);
  const badges = app.get(BadgesService);
  const users = app.get(UsersService);
  const depots = app.get(DepotsService);

  await TenantContext.system(async () => {
    // ---------------------------------------------------------------------
    // Entreprises
    // ---------------------------------------------------------------------
    const company = await prisma.raw.company.upsert({
      where: { slug: 'transports-demo' },
      update: {},
      create: {
        id: newId(),
        name: 'Transports Démo',
        slug: 'transports-demo',
        status: CompanyStatus.ACTIVE,
        settings: { detailedDenialMessages: true },
      },
    });

    // Seconde entreprise : elle n'existe que pour que les tests d'isolation
    // aient quelque chose à ne PAS voir.
    const otherCompany = await prisma.raw.company.upsert({
      where: { slug: 'autre-transport' },
      update: {},
      create: {
        id: newId(),
        name: 'Autre Transport',
        slug: 'autre-transport',
        status: CompanyStatus.ACTIVE,
      },
    });

    for (const c of [company, otherCompany]) {
      await prisma.raw.retentionPolicy.upsert({
        where: { companyId: c.id },
        update: {},
        create: { companyId: c.id },
      });
      await prisma.raw.deviceSettings.findFirst({
        where: { companyId: c.id, deviceId: null, depotId: null },
      }).then(async (existing) => {
        if (!existing) {
          await prisma.raw.deviceSettings.create({
            data: {
              id: newId(),
              companyId: c.id,
              allowedApps: [
                'com.android.dialer',
                'com.google.android.apps.messaging',
                'com.google.android.apps.maps',
              ],
            },
          });
        }
      });
    }

    // ---------------------------------------------------------------------
    // Administrateurs
    // ---------------------------------------------------------------------
    const superAdminEmail =
      process.env.SEED_SUPER_ADMIN_EMAIL ?? 'admin@phone-control.local';
    const superAdminPassword =
      process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe!2026';
    const passwordHash = await tokens.hashPassword(superAdminPassword);

    await prisma.raw.admin.upsert({
      where: { email: superAdminEmail },
      update: { passwordHash },
      create: {
        id: newId(),
        email: superAdminEmail,
        passwordHash,
        firstName: 'Super',
        lastName: 'Admin',
        role: AdminRole.SUPER_ADMIN,
        companyId: null,
        depotScope: [],
      },
    });

    await prisma.raw.admin.upsert({
      where: { email: 'exploitation@transports-demo.local' },
      update: { passwordHash },
      create: {
        id: newId(),
        email: 'exploitation@transports-demo.local',
        passwordHash,
        firstName: 'Claire',
        lastName: 'Exploitation',
        role: AdminRole.COMPANY_ADMIN,
        companyId: company.id,
        depotScope: [],
      },
    });

    // ---------------------------------------------------------------------
    // Dépôt (règles 18h / 22h, fuseau Europe/Paris)
    // ---------------------------------------------------------------------
    let depot = await prisma.raw.depot.findFirst({
      where: { companyId: company.id, code: 'MRS' },
    });
    if (!depot) {
      depot = await depots.create(company.id, {
        code: 'MRS',
        name: 'Dépôt Marseille',
        latitude: 43.296482,
        longitude: 5.36978,
        radiusMeters: 250,
        exitHysteresisMeters: 75,
        timezone: 'Europe/Paris',
        returnTime: '18:00',
        lockTime: '22:00',
        operationalDayStart: '04:00',
        scheduleOverrides: {
          // Illustration de l'exigence « week-end et jours fériés » :
          // samedi verrouillage avancé, dimanche aucune règle.
          weekdays: {
            '6': { lockTime: '20:00' },
            '7': null,
          },
        },
      });
    }

    // ---------------------------------------------------------------------
    // Téléphones
    // ---------------------------------------------------------------------
    const assetTags = ['TEL-001', 'TEL-003', 'TEL-008', 'TEL-023'];
    const devices = [];
    for (const assetTag of assetTags) {
      const existing = await prisma.raw.device.findFirst({
        where: { companyId: company.id, assetTag },
      });
      devices.push(
        existing ??
          (await prisma.raw.device.create({
            data: {
              id: newId(),
              companyId: company.id,
              depotId: depot.id,
              assetTag,
              manufacturer: 'samsung',
              model: 'SM-A165F',
              androidVersion: '14',
              appVersion: '1.0.0',
              kioskMode: KioskMode.KIOSK,
              // TEL-023 est présenté comme déjà enrôlé pour que les scénarios
              // de scan soient jouables immédiatement.
              enrollmentStatus:
                assetTag === 'TEL-023'
                  ? DeviceEnrollmentStatus.ENROLLED
                  : DeviceEnrollmentStatus.PENDING,
              deviceOwnerActive: assetTag === 'TEL-023',
              state:
                assetTag === 'TEL-023' ? DeviceState.LOCKED : DeviceState.UNKNOWN,
              enrolledAt: assetTag === 'TEL-023' ? new Date() : null,
            },
          })),
      );
    }
    const byTag = Object.fromEntries(devices.map((d) => [d.assetTag, d]));

    // ---------------------------------------------------------------------
    // Chauffeurs et badges
    // ---------------------------------------------------------------------
    const roster: Array<{
      firstName: string;
      lastName: string;
      employeeNumber: string;
      barcode: string;
      devices: string[];
    }> = [
      {
        firstName: 'Rémy',
        lastName: 'Simon',
        employeeNumber: 'MAT-0001',
        // Badge réel fourni pour les tests.
        barcode: '14557719',
        devices: ['TEL-023', 'TEL-001'],
      },
      {
        firstName: 'Jean',
        lastName: 'Dupont',
        employeeNumber: 'MAT-0002',
        barcode: '10000001',
        devices: ['TEL-001', 'TEL-003', 'TEL-008'],
      },
      {
        firstName: 'Marc',
        lastName: 'Martin',
        employeeNumber: 'MAT-0003',
        barcode: '10000002',
        devices: ['TEL-023'],
      },
    ];

    for (const entry of roster) {
      let user = await prisma.raw.user.findFirst({
        where: { companyId: company.id, employeeNumber: entry.employeeNumber },
      });
      if (!user) {
        user = await users.create({
          companyId: company.id,
          firstName: entry.firstName,
          lastName: entry.lastName,
          employeeNumber: entry.employeeNumber,
          depotId: depot.id,
        });
      }

      const hasBadge = await prisma.raw.badge.findFirst({
        where: { userId: user.id },
      });
      if (!hasBadge) {
        const badge = await badges.create({
          companyId: company.id,
          userId: user.id,
          rawBarcode: entry.barcode,
        });
        logger.log(
          `Badge ${badge.maskedBarcode} enregistré pour ${entry.firstName} ${entry.lastName}` +
            (badge.offlineCapable ? '' : ' (sans capacité hors ligne)'),
        );
      }

      for (const tag of entry.devices) {
        await users.assignDevice(
          company.id,
          user.id,
          byTag[tag].id,
          // Affectation créée par le seed, pas par un administrateur réel.
          (await prisma.raw.admin.findFirstOrThrow({
            where: { companyId: company.id },
          })).id,
        );
      }
    }

    // ---------------------------------------------------------------------
    // Entreprise concurrente : un chauffeur, un badge, un téléphone
    // ---------------------------------------------------------------------
    const otherUser =
      (await prisma.raw.user.findFirst({ where: { companyId: otherCompany.id } })) ??
      (await users.create({
        companyId: otherCompany.id,
        firstName: 'Paul',
        lastName: 'Étranger',
        employeeNumber: 'X-001',
      }));

    const otherBadge = await prisma.raw.badge.findFirst({
      where: { userId: otherUser.id },
    });
    if (!otherBadge) {
      // Volontairement le MÊME numéro que Rémy Simon : deux entreprises
      // peuvent utiliser la même numérotation de badges sans se voir.
      await badges.create({
        companyId: otherCompany.id,
        userId: otherUser.id,
        rawBarcode: '14557719',
      });
    }

    logger.log('--------------------------------------------------------');
    logger.log(`Entreprise      : ${company.name} (${company.slug})`);
    logger.log(`Dépôt           : ${depot.name} — retour ${depot.returnTime}, verrouillage ${depot.lockTime} (${depot.timezone})`);
    logger.log(`Téléphones      : ${assetTags.join(', ')}`);
    logger.log(`Super admin     : ${superAdminEmail} / ${superAdminPassword}`);
    logger.log(`Admin société   : exploitation@transports-demo.local / ${superAdminPassword}`);
    logger.log('Badge de test   : 14557719 -> Rémy Simon (TEL-023, TEL-001)');
    logger.log('--------------------------------------------------------');
  });

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
