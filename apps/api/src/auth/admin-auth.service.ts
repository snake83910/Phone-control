import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AdminStatus, SecurityEventType, SecuritySeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../crypto/token.service';
import { newId } from '../common/ids';
import { TenantContext } from '../common/tenant-context';
import { AuthTokensDto } from './dto/admin-auth.dto';

/** Verrouillage progressif : 5 échecs -> 15 min (cf. docs/07 §2.1). */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tokens: TokenService,
  ) {}

  async login(email: string, password: string): Promise<AuthTokensDto> {
    const ctx = TenantContext.get();

    // Client brut : l'entreprise n'est pas encore connue à cet instant.
    const admin = await this.prisma.raw.admin.findUnique({
      where: { email },
    });

    // Message unique quelle que soit la cause : ne jamais révéler si l'adresse
    // existe. On effectue tout de même une vérification factice pour que la
    // durée de réponse ne trahisse pas l'existence du compte.
    const genericFailure = new UnauthorizedException(
      'Identifiants invalides.',
    );

    if (!admin || admin.deletedAt || admin.status !== AdminStatus.ACTIVE) {
      await this.tokens.verifyPassword(DUMMY_HASH, password);
      throw genericFailure;
    }

    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await this.recordSecurityEvent(admin.companyId, SecurityEventType.LOGIN_FAILED, {
        reason: 'ACCOUNT_LOCKED',
        adminId: admin.id,
        ip: ctx?.ip,
      });
      throw new UnauthorizedException(
        'Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard.',
      );
    }

    const valid = await this.tokens.verifyPassword(admin.passwordHash, password);

    if (!valid) {
      const attempts = admin.failedAttempts + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      await this.prisma.raw.admin.update({
        where: { id: admin.id },
        data: {
          failedAttempts: attempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
        },
      });
      await this.recordSecurityEvent(admin.companyId, SecurityEventType.LOGIN_FAILED, {
        reason: 'BAD_PASSWORD',
        adminId: admin.id,
        attempts,
        locked: shouldLock,
        ip: ctx?.ip,
      });
      throw genericFailure;
    }

    await this.prisma.raw.admin.update({
      where: { id: admin.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    await this.recordSecurityEvent(admin.companyId, SecurityEventType.LOGIN_SUCCESS, {
      adminId: admin.id,
      ip: ctx?.ip,
    });

    return this.issueTokens(admin.id, newId());
  }

  /**
   * Rotation avec détection de réutilisation.
   *
   * Un jeton de rafraîchissement ne sert qu'une fois. S'il réapparaît après
   * usage, c'est qu'il a été volé (ou rejoué) : toute la famille est révoquée,
   * ce qui déconnecte à la fois l'attaquant et la victime. C'est le
   * comportement correct — mieux vaut une reconnexion qu'une session pillée.
   */
  async refresh(refreshToken: string): Promise<AuthTokensDto> {
    const tokenHash = this.tokens.hashToken(refreshToken);

    const stored = await this.prisma.raw.adminRefreshToken.findUnique({
      where: { tokenHash },
      include: { admin: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Jeton de rafraîchissement inconnu.');
    }

    if (stored.usedAt || stored.revokedAt) {
      await this.prisma.raw.adminRefreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.recordSecurityEvent(
        stored.admin.companyId,
        SecurityEventType.LOGIN_FAILED,
        {
          reason: 'REFRESH_TOKEN_REUSE',
          adminId: stored.adminId,
          familyId: stored.familyId,
        },
        SecuritySeverity.HIGH,
      );
      this.logger.warn(
        `Réutilisation d'un jeton de rafraîchissement : famille ${stored.familyId} révoquée.`,
      );
      throw new UnauthorizedException(
        'Jeton déjà utilisé. Toutes les sessions ont été révoquées par sécurité.',
      );
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Jeton de rafraîchissement expiré.');
    }

    if (
      stored.admin.deletedAt ||
      stored.admin.status !== AdminStatus.ACTIVE
    ) {
      throw new UnauthorizedException('Compte administrateur inactif.');
    }

    await this.prisma.raw.adminRefreshToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    });

    return this.issueTokens(stored.adminId, stored.familyId);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.tokens.hashToken(refreshToken);
    const stored = await this.prisma.raw.adminRefreshToken.findUnique({
      where: { tokenHash },
      select: { familyId: true },
    });
    if (!stored) return;
    await this.prisma.raw.adminRefreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(
    adminId: string,
    familyId: string,
  ): Promise<AuthTokensDto> {
    const admin = await this.prisma.raw.admin.findUniqueOrThrow({
      where: { id: adminId },
    });

    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    const refreshTtlDays = parseDays(
      this.config.get<string>('JWT_REFRESH_TTL') ?? '7d',
    );

    const accessToken = await this.jwt.signAsync(
      {
        sub: admin.id,
        typ: 'admin',
        role: admin.role,
        companyId: admin.companyId,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: parseSeconds(accessTtl),
      },
    );

    const refreshToken = this.tokens.generateOpaqueToken();
    const ctx = TenantContext.get();

    await this.prisma.raw.adminRefreshToken.create({
      data: {
        id: newId(),
        adminId: admin.id,
        tokenHash: this.tokens.hashToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + refreshTtlDays * 86_400_000),
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: parseSeconds(accessTtl),
      admin: {
        id: admin.id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role,
        companyId: admin.companyId,
        depotScope: admin.depotScope,
      },
    };
  }

  private async recordSecurityEvent(
    companyId: string | null,
    type: SecurityEventType,
    metadata: Record<string, unknown>,
    severity: SecuritySeverity = SecuritySeverity.LOW,
  ): Promise<void> {
    // Un SUPER_ADMIN n'appartient à aucune entreprise : l'événement n'est alors
    // pas rattachable, on se contente du journal applicatif.
    if (!companyId) {
      this.logger.log(`${type} ${JSON.stringify(metadata)}`);
      return;
    }
    await this.prisma.raw.securityEvent.create({
      data: {
        id: newId(),
        companyId,
        type,
        severity,
        occurredAt: new Date(),
        metadata: metadata as never,
      },
    });
  }
}

/** Hachage factice, utilisé pour égaliser le temps de réponse. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$JXR0jGYyFPnT4WJ0nUJHrYNrpEJOVQ0Bq0bqRB0oTfA';

function parseDays(ttl: string): number {
  const m = /^(\d+)d$/.exec(ttl);
  return m ? Number(m[1]) : 7;
}

function parseSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 900;
  const value = Number(m[1]);
  const unit = m[2];
  const factor = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return value * factor;
}
