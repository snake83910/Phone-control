import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceEnrollmentStatus, DeviceState, KioskMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../crypto/token.service';
import { BadgeHashService } from '../crypto/badge-hash.service';
import { DeviceTokenService } from '../auth/device-token.service';
import { SettingsService } from '../settings/settings.service';
import { newId } from '../common/ids';
import { toBytes } from '../common/bytes';
import { TenantContext } from '../common/tenant-context';
import { EnrollDeviceDto } from './dto/device.dto';

/**
 * Enrôlement d'un téléphone — étapes 1 et 7 de la procédure décrite dans
 * docs/04-device-owner-kiosque.md §3.
 *
 * Le jeton d'enrôlement est à usage unique et à durée limitée : c'est lui qui
 * rattache un téléphone à une entreprise et à un dépôt sans aucune saisie sur
 * le terminal, puisqu'il voyage dans le QR code de provisioning.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly badgeHash: BadgeHashService,
    private readonly deviceTokens: DeviceTokenService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  /** Création d'un jeton d'enrôlement par un administrateur. */
  async createToken(params: {
    companyId: string;
    depotId?: string | null;
    assetTag?: string | null;
    deviceId?: string | null;
    kioskMode?: KioskMode;
    createdBy: string;
  }): Promise<{ token: string; expiresAt: Date; id: string }> {
    const token = this.tokens.generateEnrollmentToken();
    const ttlDays = this.config.get<number>('ENROLLMENT_TOKEN_TTL_DAYS') ?? 7;
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);

    const row = await this.prisma.raw.enrollmentToken.create({
      data: {
        id: newId(),
        companyId: params.companyId,
        depotId: params.depotId ?? null,
        deviceId: params.deviceId ?? null,
        assetTag: params.assetTag ?? null,
        kioskMode: params.kioskMode ?? KioskMode.KIOSK,
        tokenHash: this.tokens.hashToken(token),
        expiresAt,
        createdBy: params.createdBy,
      },
    });

    // Le jeton en clair n'est renvoyé qu'ici, une seule fois : il n'est stocké
    // que sous forme d'empreinte.
    return { token, expiresAt, id: row.id };
  }

  /**
   * Consommation du jeton par le téléphone, en fin de provisioning.
   * Route publique : l'appareil n'a encore aucune identité.
   */
  async enroll(dto: EnrollDeviceDto): Promise<{
    deviceId: string;
    assetTag: string;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    offlineKey: string;
    settings: unknown;
    depot: unknown;
  }> {
    const tokenHash = this.tokens.hashToken(dto.enrollmentToken);

    const enrollment = await this.prisma.raw.enrollmentToken.findUnique({
      where: { tokenHash },
      include: { depot: true },
    });

    if (!enrollment) {
      throw new UnauthorizedException("Jeton d'enrôlement inconnu.");
    }
    if (enrollment.usedAt) {
      throw new UnauthorizedException("Jeton d'enrôlement déjà utilisé.");
    }
    if (enrollment.expiresAt < new Date()) {
      throw new UnauthorizedException("Jeton d'enrôlement expiré.");
    }

    const assetTag = enrollment.assetTag ?? `TEL-${Date.now().toString(36).toUpperCase()}`;

    const device = await this.prisma.raw.$transaction(async (tx) => {
      const existing = enrollment.deviceId
        ? await tx.device.findUnique({ where: { id: enrollment.deviceId } })
        : await tx.device.findUnique({
            where: {
              companyId_assetTag: { companyId: enrollment.companyId, assetTag },
            },
          });

      const common = {
        companyId: enrollment.companyId,
        depotId: enrollment.depotId,
        serialNumber: dto.serialNumber ?? null,
        imei: dto.imei ?? null,
        manufacturer: dto.manufacturer ?? null,
        model: dto.model ?? null,
        androidVersion: dto.androidVersion ?? null,
        appVersion: dto.appVersion ?? null,
        deviceOwnerActive: dto.deviceOwnerActive,
        kioskMode: enrollment.kioskMode,
        enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
        state: DeviceState.LOCKED,
        enrolledAt: new Date(),
        lastSeenAt: new Date(),
        publicKey: dto.publicKey
          ? toBytes(Buffer.from(dto.publicKey, 'base64'))
          : null,
        revokedAt: null,
      };

      const saved = existing
        ? await tx.device.update({ where: { id: existing.id }, data: common })
        : await tx.device.create({
            data: { id: newId(), assetTag, ...common },
          });

      // Clé HMAC propre à l'appareil : c'est elle qui rend la liste de badges
      // hors ligne inutilisable sur un autre terminal (docs/05 §3.1).
      const offlineKey = this.badgeHash.deriveDeviceKey(saved.id);
      await tx.device.update({
        where: { id: saved.id },
        data: { offlineKey: toBytes(offlineKey) },
      });

      await tx.enrollmentToken.update({
        where: { id: enrollment.id },
        data: { usedAt: new Date(), deviceId: saved.id },
      });

      return saved;
    });

    if (!dto.deviceOwnerActive) {
      this.logger.warn(
        `Appareil ${device.assetTag} enrôlé SANS Device Owner : le verrouillage ` +
          `kiosque n'est pas garanti sur ce terminal.`,
      );
    }

    const tokens = await TenantContext.system(() =>
      this.deviceTokens.issue(device.id, device.companyId),
    );

    const settings = await this.settings.resolveForDevice(
      device.companyId,
      device.id,
      device.depotId,
    );

    return {
      deviceId: device.id,
      assetTag: device.assetTag,
      ...tokens,
      offlineKey: this.badgeHash.deriveDeviceKey(device.id).toString('base64'),
      settings,
      depot: enrollment.depot
        ? {
            id: enrollment.depot.id,
            name: enrollment.depot.name,
            latitude: enrollment.depot.latitude,
            longitude: enrollment.depot.longitude,
            radiusMeters: enrollment.depot.radiusMeters,
            exitHysteresisMeters: enrollment.depot.exitHysteresisMeters,
            timezone: enrollment.depot.timezone,
            returnTime: enrollment.depot.returnTime,
            lockTime: enrollment.depot.lockTime,
            operationalDayStart: enrollment.depot.operationalDayStart,
            scheduleOverrides: enrollment.depot.scheduleOverrides,
          }
        : null,
    };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const device = await this.prisma.db.device.findFirst({
      where: { id: deviceId },
    });
    if (!device) throw new BadRequestException('Appareil introuvable.');

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.device.update({
        where: { id: deviceId },
        data: {
          enrollmentStatus: DeviceEnrollmentStatus.REVOKED,
          revokedAt: new Date(),
          state: DeviceState.LOCKED,
        },
      });
      await tx.deviceCredential.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}
