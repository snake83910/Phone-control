import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DeviceEnrollmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../crypto/token.service';
import { newId } from '../common/ids';
import { TenantContext } from '../common/tenant-context';

export interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Jetons d'appareil — distincts des sessions chauffeur (docs/02 §2).
 *
 * Un téléphone reste authentifié même verrouillé : sans cela, il ne pourrait
 * recevoir ni ordre de déverrouillage, ni configuration, ni commande.
 */
@Injectable()
export class DeviceTokenService {
  private readonly logger = new Logger(DeviceTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
  ) {}

  async issue(deviceId: string, companyId: string, familyId?: string): Promise<DeviceTokens> {
    const accessTtl = this.config.get<string>('DEVICE_ACCESS_TTL') ?? '60m';
    const refreshDays = parseDays(
      this.config.get<string>('DEVICE_REFRESH_TTL') ?? '30d',
    );

    const accessToken = await this.jwt.signAsync(
      { sub: deviceId, typ: 'device', companyId },
      {
        secret: this.config.getOrThrow<string>('DEVICE_JWT_SECRET'),
        expiresIn: parseSeconds(accessTtl),
      },
    );

    const refreshToken = this.tokens.generateOpaqueToken();
    const ctx = TenantContext.get();

    await this.prisma.raw.deviceCredential.create({
      data: {
        id: newId(),
        deviceId,
        refreshTokenHash: this.tokens.hashToken(refreshToken),
        familyId: familyId ?? newId(),
        expiresAt: new Date(Date.now() + refreshDays * 86_400_000),
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      },
    });

    return { accessToken, refreshToken, expiresIn: parseSeconds(accessTtl) };
  }

  /** Même politique de rotation et de détection de réutilisation que côté admin. */
  async refresh(refreshToken: string): Promise<DeviceTokens> {
    const hash = this.tokens.hashToken(refreshToken);
    const stored = await this.prisma.raw.deviceCredential.findUnique({
      where: { refreshTokenHash: hash },
      include: { device: { select: { id: true, companyId: true, enrollmentStatus: true, deletedAt: true } } },
    });

    if (!stored) {
      throw new UnauthorizedException("Jeton d'appareil inconnu.");
    }

    if (stored.usedAt || stored.revokedAt) {
      await this.prisma.raw.deviceCredential.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Réutilisation d'un jeton d'appareil : famille ${stored.familyId} révoquée ` +
          `(appareil ${stored.deviceId}).`,
      );
      throw new UnauthorizedException(
        'Jeton déjà utilisé. Les identifiants de cet appareil ont été révoqués.',
      );
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Jeton d'appareil expiré.");
    }

    if (
      stored.device.deletedAt ||
      stored.device.enrollmentStatus !== DeviceEnrollmentStatus.ENROLLED
    ) {
      throw new UnauthorizedException('Appareil révoqué.');
    }

    await this.prisma.raw.deviceCredential.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    });

    return this.issue(stored.deviceId, stored.device.companyId, stored.familyId);
  }

  async revokeAll(deviceId: string): Promise<void> {
    await this.prisma.raw.deviceCredential.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

function parseDays(ttl: string): number {
  const m = /^(\d+)d$/.exec(ttl);
  return m ? Number(m[1]) : 30;
}

function parseSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 3600;
  const value = Number(m[1]);
  const unit = m[2];
  const factor = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return value * factor;
}
