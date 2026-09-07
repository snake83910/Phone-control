import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  AlertSeverity,
  AlertType,
  BadgeStatus,
  BarcodeScanResult,
  DeviceEnrollmentStatus,
  DeviceState,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
  SessionEndReason,
  SessionStatus,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BadgeHashService,
  BadgeNormalizationError,
  maskBarcode,
} from '../crypto/badge-hash.service';
import { RateLimiterService } from '../redis/rate-limiter.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { newId } from '../common/ids';
import { toBytes } from '../common/bytes';
import { TenantContext } from '../common/tenant-context';
import {
  BarcodeAuthDto,
  BarcodeAuthResponseDto,
  BarcodeDenialReason,
} from './dto/barcode-auth.dto';

/**
 * Authentification d'un chauffeur par son badge Code 128.
 *
 * Le serveur est l'autorité : le téléphone ne décide jamais seul quand le
 * serveur est joignable (§4 de la spécification). Les neuf contrôles sont
 * exécutés dans l'ordre imposé par docs/02 §3, chacun produisant une trace.
 *
 * NOTE DE SÉCURITÉ — granularité des refus.
 * La spécification (§10) demande d'afficher « Ce téléphone n'est pas autorisé
 * pour cet utilisateur », ce qui révèle qu'un badge scanné est valide. C'est un
 * compromis assumé, indispensable en exploitation : un chauffeur devant un
 * refus doit savoir s'il s'est trompé de téléphone. Il est compensé par la
 * limitation de débit, le verrouillage après échecs répétés et l'alerte
 * UNKNOWN_BADGE. Il reste désactivable par entreprise via le réglage
 * `detailedDenialMessages`.
 */
@Injectable()
export class BarcodeAuthService {
  private readonly logger = new Logger(BarcodeAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly badgeHash: BadgeHashService,
    private readonly rateLimiter: RateLimiterService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
  ) {}

  async authenticate(
    dto: BarcodeAuthDto,
    authenticatedDeviceId: string,
  ): Promise<BarcodeAuthResponseDto> {
    // L'appareil est déjà authentifié par son jeton. Si la charge utile
    // désigne un autre appareil, c'est soit un bug client, soit une tentative
    // d'usurpation : refus net, sans trace de scan.
    if (dto.deviceId !== authenticatedDeviceId) {
      throw new ForbiddenException(
        "L'identifiant d'appareil de la requête ne correspond pas au jeton présenté.",
      );
    }

    const scannedAt = dto.scannedAt ? new Date(dto.scannedAt) : new Date();
    const limits = this.rateLimiter.barcodeLimits;

    // --- Contrôle 9 (par anticipation) : verrouillage et quotas --------------
    if (await this.rateLimiter.isLockedOut('barcode', authenticatedDeviceId)) {
      return this.deny(
        'RATE_LIMITED',
        BarcodeScanResult.RATE_LIMITED,
        { dto, scannedAt, deviceId: authenticatedDeviceId },
        limits.lockoutMinutes * 60,
      );
    }

    const deviceQuota = await this.rateLimiter.consume(
      'barcode:device',
      authenticatedDeviceId,
      limits.perDevicePerMinute,
      60,
    );
    if (!deviceQuota.allowed) {
      return this.deny(
        'RATE_LIMITED',
        BarcodeScanResult.RATE_LIMITED,
        { dto, scannedAt, deviceId: authenticatedDeviceId },
        deviceQuota.retryAfterSeconds,
      );
    }

    // --- Normalisation et empreinte ----------------------------------------
    let described: ReturnType<BadgeHashService['describe']>;
    try {
      described = this.badgeHash.describe(dto.barcode);
    } catch (err) {
      if (err instanceof BadgeNormalizationError) {
        return this.deny('BADGE_DENIED', BarcodeScanResult.UNKNOWN_BADGE, {
          dto,
          scannedAt,
          deviceId: authenticatedDeviceId,
        });
      }
      throw err;
    }

    const badgeQuota = await this.rateLimiter.consume(
      'barcode:badge',
      described.hash.toString('base64url'),
      limits.perBadgePerMinute,
      60,
    );
    if (!badgeQuota.allowed) {
      return this.deny(
        'RATE_LIMITED',
        BarcodeScanResult.RATE_LIMITED,
        { dto, scannedAt, deviceId: authenticatedDeviceId, described },
        badgeQuota.retryAfterSeconds,
      );
    }

    // --- Contrôles 4, 5 : l'appareil ---------------------------------------
    const device = await this.prisma.raw.device.findUnique({
      where: { id: authenticatedDeviceId },
      include: { company: { select: { id: true, status: true, settings: true } } },
    });

    if (
      !device ||
      device.deletedAt ||
      device.enrollmentStatus !== DeviceEnrollmentStatus.ENROLLED ||
      device.revokedAt
    ) {
      return this.deny('DEVICE_UNAVAILABLE', BarcodeScanResult.DEVICE_REVOKED, {
        dto,
        scannedAt,
        deviceId: authenticatedDeviceId,
        described,
      });
    }

    const companyId = device.companyId;
    const detailedMessages = readBooleanSetting(
      device.company.settings,
      'detailedDenialMessages',
      true,
    );

    // --- Contrôles 1, 2, 7 : le badge --------------------------------------
    // La recherche est un accès par index sur (company_id, barcode_hash) :
    // le cloisonnement d'entreprise fait partie du critère, pas d'un filtre
    // appliqué après coup.
    const badge = await this.prisma.raw.badge.findFirst({
      where: { companyId, barcodeHash: toBytes(described.hash) },
      include: { user: true },
    });

    if (!badge) {
      await this.recordScan({
        companyId,
        deviceId: device.id,
        result: BarcodeScanResult.UNKNOWN_BADGE,
        described,
        dto,
        scannedAt,
      });
      await this.recordSecurityEvent(
        companyId,
        device.id,
        null,
        SecurityEventType.UNKNOWN_BADGE,
        SecuritySeverity.MEDIUM,
        { last4: described.last4, length: described.length },
      );
      await this.registerFailure(device.id, companyId);
      await this.alerts.raise({
        companyId,
        deviceId: device.id,
        depotId: device.depotId,
        type: AlertType.UNKNOWN_BADGE,
        severity: AlertSeverity.MEDIUM,
        title: 'Badge inconnu présenté',
        message: `Un badge inconnu (${maskBarcode(described.last4, described.length)}) a été présenté sur ${device.assetTag}.`,
        // Une seule alerte par appareil et par heure : sinon une tentative
        // d'énumération noierait le dashboard.
        dedupeKey: `unknown-badge:${device.id}:${hourBucket(scannedAt)}`,
        context: { last4: described.last4, assetTag: device.assetTag },
      });
      return this.denyResponse('BADGE_DENIED', detailedMessages);
    }

    // --- Contrôle 3 : le badge est-il exploitable ? -------------------------
    if (badge.status !== BadgeStatus.ACTIVE) {
      const result =
        badge.status === BadgeStatus.REVOKED
          ? BarcodeScanResult.BADGE_REVOKED
          : BarcodeScanResult.BADGE_INACTIVE;
      await this.recordScan({
        companyId,
        deviceId: device.id,
        badgeId: badge.id,
        userId: badge.userId,
        result,
        described,
        dto,
        scannedAt,
      });
      await this.recordSecurityEvent(
        companyId,
        device.id,
        badge.userId,
        SecurityEventType.UNAUTHORIZED_USER,
        SecuritySeverity.MEDIUM,
        { reason: badge.status, badgeId: badge.id },
      );
      await this.registerFailure(device.id, companyId);
      return this.denyResponse('BADGE_DENIED', detailedMessages);
    }

    // --- Contrôle 3bis : l'utilisateur est-il actif ? -----------------------
    if (badge.user.status !== UserStatus.ACTIVE || badge.user.deletedAt) {
      await this.recordScan({
        companyId,
        deviceId: device.id,
        badgeId: badge.id,
        userId: badge.userId,
        result: BarcodeScanResult.USER_INACTIVE,
        described,
        dto,
        scannedAt,
      });
      await this.recordSecurityEvent(
        companyId,
        device.id,
        badge.userId,
        SecurityEventType.UNAUTHORIZED_USER,
        SecuritySeverity.MEDIUM,
        { reason: 'USER_INACTIVE' },
      );
      await this.registerFailure(device.id, companyId);
      return this.denyResponse('BADGE_DENIED', detailedMessages);
    }

    // --- Contrôle 7 : cohérence des entreprises ----------------------------
    // Redondant avec le filtre de recherche, mais explicite : une incohérence
    // ici traduirait une corruption de données, qui doit être bruyante.
    if (badge.companyId !== companyId || badge.user.companyId !== companyId) {
      this.logger.error(
        `Incohérence multi-entreprises : badge ${badge.id} (${badge.companyId}), ` +
          `utilisateur ${badge.userId} (${badge.user.companyId}), appareil ${device.id} (${companyId}).`,
      );
      await this.recordScan({
        companyId,
        deviceId: device.id,
        badgeId: badge.id,
        userId: badge.userId,
        result: BarcodeScanResult.COMPANY_MISMATCH,
        described,
        dto,
        scannedAt,
      });
      return this.denyResponse('BADGE_DENIED', detailedMessages);
    }

    // --- Contrôle 6 : ce chauffeur peut-il utiliser CE téléphone ? ----------
    const now = new Date();
    const assignment = await this.prisma.raw.deviceAssignment.findFirst({
      where: {
        companyId,
        userId: badge.userId,
        deviceId: device.id,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
      },
    });

    if (!assignment) {
      await this.recordScan({
        companyId,
        deviceId: device.id,
        badgeId: badge.id,
        userId: badge.userId,
        result: BarcodeScanResult.DEVICE_NOT_AUTHORIZED,
        described,
        dto,
        scannedAt,
      });
      await this.recordSecurityEvent(
        companyId,
        device.id,
        badge.userId,
        SecurityEventType.UNAUTHORIZED_USER,
        SecuritySeverity.MEDIUM,
        { reason: 'DEVICE_NOT_ASSIGNED', assetTag: device.assetTag },
      );
      await this.registerFailure(device.id, companyId);
      await this.alerts.raise({
        companyId,
        deviceId: device.id,
        userId: badge.userId,
        depotId: device.depotId,
        type: AlertType.UNAUTHORIZED_USER,
        severity: AlertSeverity.MEDIUM,
        title: 'Utilisateur non autorisé sur ce téléphone',
        message: `${badge.user.firstName} ${badge.user.lastName} a présenté son badge sur ${device.assetTag}, qui ne lui est pas affecté.`,
        dedupeKey: `unauthorized:${device.id}:${badge.userId}:${hourBucket(scannedAt)}`,
        context: { assetTag: device.assetTag },
      });
      return this.denyResponse('DEVICE_NOT_AUTHORIZED', detailedMessages);
    }

    // --- Succès : ouverture de session -------------------------------------
    const settings = await this.settings.resolveForDevice(
      companyId,
      device.id,
      device.depotId,
    );
    const expiresAt = new Date(
      now.getTime() + settings.sessionMaxDurationMinutes * 60_000,
    );

    const session = await this.prisma.raw.$transaction(async (tx) => {
      // Un nouveau scan remplace la session précédente (§11 de la
      // spécification). Deux fermetures : celle du téléphone, et celle que le
      // chauffeur aurait laissée ouverte sur un autre téléphone — les index
      // uniques partiels imposent l'une et l'autre.
      await tx.session.updateMany({
        where: { deviceId: device.id, status: SessionStatus.ACTIVE },
        data: {
          status: SessionStatus.ENDED,
          endedAt: now,
          endReason: SessionEndReason.NEW_SESSION,
        },
      });
      await tx.session.updateMany({
        where: { userId: badge.userId, status: SessionStatus.ACTIVE },
        data: {
          status: SessionStatus.ENDED,
          endedAt: now,
          endReason: SessionEndReason.NEW_SESSION,
        },
      });

      const created = await tx.session.create({
        data: {
          id: newId(),
          companyId,
          userId: badge.userId,
          deviceId: device.id,
          depotId: device.depotId,
          badgeId: badge.id,
          startedAt: now,
          expiresAt,
          status: SessionStatus.ACTIVE,
        },
      });

      await tx.device.update({
        where: { id: device.id },
        data: { state: DeviceState.ACTIVE, lastSeenAt: now },
      });

      return created;
    });

    await this.recordScan({
      companyId,
      deviceId: device.id,
      badgeId: badge.id,
      userId: badge.userId,
      result: BarcodeScanResult.SUCCESS,
      described,
      dto,
      scannedAt,
      sessionId: session.id,
    });
    await this.recordSecurityEvent(
      companyId,
      device.id,
      badge.userId,
      SecurityEventType.SESSION_STARTED,
      SecuritySeverity.LOW,
      { sessionId: session.id, assetTag: device.assetTag },
      session.id,
    );
    await this.rateLimiter.clearFailures('barcode', device.id);

    return {
      success: true,
      user: {
        id: badge.user.id,
        firstName: badge.user.firstName,
        lastName: badge.user.lastName,
      },
      session: {
        id: session.id,
        startedAt: session.startedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------

  private denyResponse(
    reason: BarcodeDenialReason,
    detailed: boolean,
    retryAfterSeconds?: number,
  ): BarcodeAuthResponseDto {
    const messages: Record<BarcodeDenialReason, string> = {
      BADGE_DENIED: 'Accès refusé. Badge non reconnu ou non autorisé.',
      DEVICE_NOT_AUTHORIZED:
        "Accès refusé. Ce téléphone n'est pas autorisé pour cet utilisateur.",
      DEVICE_UNAVAILABLE:
        'Accès refusé. Ce téléphone n’est plus autorisé : contactez votre responsable.',
      RATE_LIMITED: 'Trop de tentatives. Patientez avant de réessayer.',
    };

    const effective: BarcodeDenialReason =
      detailed || reason === 'RATE_LIMITED' ? reason : 'BADGE_DENIED';

    return {
      success: false,
      reason: effective,
      message: messages[effective],
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  /** Refus survenant avant identification de l'entreprise (quotas, appareil KO). */
  private async deny(
    reason: BarcodeDenialReason,
    result: BarcodeScanResult,
    ctx: {
      dto: BarcodeAuthDto;
      scannedAt: Date;
      deviceId: string;
      described?: ReturnType<BadgeHashService['describe']>;
    },
    retryAfterSeconds?: number,
  ): Promise<BarcodeAuthResponseDto> {
    const companyId = TenantContext.get()?.companyId;
    if (companyId) {
      await this.recordScan({
        companyId,
        deviceId: ctx.deviceId,
        result,
        described: ctx.described,
        dto: ctx.dto,
        scannedAt: ctx.scannedAt,
      });
    }
    return this.denyResponse(reason, true, retryAfterSeconds);
  }

  private async registerFailure(deviceId: string, companyId: string): Promise<void> {
    const limits = this.rateLimiter.barcodeLimits;
    const failures = await this.rateLimiter.recordFailure('barcode', deviceId, 3600);
    if (failures >= limits.lockoutFailures) {
      await this.rateLimiter.lockOut('barcode', deviceId, limits.lockoutMinutes);
      await this.alerts.raise({
        companyId,
        deviceId,
        type: AlertType.DEVICE_TAMPERING,
        severity: AlertSeverity.HIGH,
        title: 'Tentatives de badge répétées',
        message: `${failures} scans refusés en une heure : le scan est verrouillé ${limits.lockoutMinutes} minutes sur cet appareil.`,
        dedupeKey: `barcode-lockout:${deviceId}`,
        context: { failures },
      });
    }
  }

  private async recordScan(params: {
    companyId: string;
    deviceId: string;
    badgeId?: string;
    userId?: string;
    sessionId?: string;
    result: BarcodeScanResult;
    described?: ReturnType<BadgeHashService['describe']>;
    dto: BarcodeAuthDto;
    scannedAt: Date;
  }): Promise<void> {
    await this.prisma.raw.barcodeScanEvent.create({
      data: {
        id: newId(),
        companyId: params.companyId,
        deviceId: params.deviceId,
        badgeId: params.badgeId ?? null,
        userId: params.userId ?? null,
        sessionId: params.sessionId ?? null,
        // On conserve l'empreinte même pour un badge inconnu : c'est ce qui
        // permet de détecter une énumération, sans jamais stocker le numéro.
        barcodeHash: params.described ? toBytes(params.described.hash) : null,
        barcodeLast4: params.described?.last4 ?? null,
        result: params.result,
        scannedAt: params.scannedAt,
        latitude: params.dto.latitude ?? null,
        longitude: params.dto.longitude ?? null,
        offline: false,
        ip: TenantContext.get()?.ip ?? null,
      },
    });
  }

  private async recordSecurityEvent(
    companyId: string,
    deviceId: string | null,
    userId: string | null,
    type: SecurityEventType,
    severity: SecuritySeverity,
    metadata: Record<string, unknown>,
    sessionId?: string,
  ): Promise<void> {
    await this.prisma.raw.securityEvent.create({
      data: {
        id: newId(),
        companyId,
        deviceId,
        userId,
        sessionId: sessionId ?? null,
        type,
        severity,
        occurredAt: new Date(),
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

function hourBucket(date: Date): string {
  return date.toISOString().slice(0, 13);
}

function readBooleanSetting(
  settings: Prisma.JsonValue,
  key: string,
  fallback: boolean,
): boolean {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const value = (settings as Record<string, unknown>)[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}
