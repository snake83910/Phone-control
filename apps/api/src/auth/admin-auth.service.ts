import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AdminRole,
  AdminStatus,
  SecurityEventType,
  SecuritySeverity,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
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
    private readonly redis: RedisService,
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

    // Un compte créé par authentification unique n'a pas de mot de passe. Sans
    // ce refus explicite, l'ouverture du SSO créerait une porte parallèle :
    // des comptes supplémentaires, jamais destinés à la connexion directe, et
    // dont plus personne ne surveille le hachage. La vérification factice est
    // conservée pour que la durée de réponse ne les distingue pas des autres.
    if (admin.ssoOnly) {
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
   * Ouvre une session à partir d'un jeton Trajelys.
   *
   * ── Pourquoi un ÉCHANGE et non un second type de jeton accepté partout ──
   * Le jeton Trajelys est vérifié une fois, ici, puis échangé contre les
   * jetons du MDM. Toutes les routes continuent de n'accepter qu'un seul type
   * de jeton, et la révocation, les rôles, le statut du compte et la rotation
   * des jetons de rafraîchissement fonctionnent sans modification. Accepter
   * les jetons Trajelys sur chaque route aurait mis deux systèmes
   * d'authentification sur le chemin des neuf mille téléphones, dont aucun
   * n'en a besoin.
   *
   * ── L'entreprise n'est JAMAIS créée ici ─────────────────────────────────
   * Le rattachement `companies.trajelys_user_id` est posé par l'exploitant à
   * la vente du module. Un compte Supabase valide mais non rattaché est
   * refusé : sans cela, n'importe qui pourrait se provisionner une entreprise
   * en créant un compte sur Trajelys.
   *
   * L'administrateur, lui, est créé au premier passage — il n'y a rien à
   * décider à son sujet, et demander une seconde inscription à quelqu'un qui
   * vient de se connecter serait exactement ce que l'authentification unique
   * doit éviter.
   */
  /**
   * Résout — ou crée — l'administrateur correspondant à un compte Trajelys,
   * et rend son identifiant.
   *
   * Séparé de la délivrance des jetons pour que les DEUX chemins d'entrée —
   * connexion directe et code à usage unique — passent par exactement les
   * mêmes contrôles. Deux portes avec deux jeux de vérifications finissent
   * par diverger, et c'est la moins surveillée qui devient la faille.
   */
  private async resoudreAdministrateurTrajelys(identite: {
    userId: string;
    email?: string;
  }): Promise<{ adminId: string; companyId: string }> {
    const company = await this.prisma.raw.company.findUnique({
      where: { trajelysUserId: identite.userId },
      select: { id: true, name: true },
    });

    if (!company) {
      throw new UnauthorizedException(
        "Aucune entreprise Phone Control n'est rattachée à ce compte Trajelys.",
      );
    }

    let admin = await this.prisma.raw.admin.findUnique({
      where: { trajelysUserId: identite.userId },
      select: { id: true, status: true, deletedAt: true, companyId: true },
    });

    if (admin && (admin.deletedAt || admin.status !== AdminStatus.ACTIVE)) {
      // Désactivé ici, il le reste : l'authentification unique ne doit pas
      // servir de contournement à une exclusion décidée dans ce produit.
      throw new UnauthorizedException('Compte administrateur inactif.');
    }

    if (!admin) {
      const cree = await this.prisma.raw.admin.create({
        data: {
          id: newId(),
          trajelysUserId: identite.userId,
          companyId: company.id,
          email: identite.email ?? `trajelys-${identite.userId}@sso.local`,
          // Hachage inutilisable, en plus du drapeau : même si la
          // vérification de `ssoOnly` disparaissait un jour, ce compte ne
          // s'ouvrirait pas par mot de passe.
          passwordHash: await this.tokens.hashPassword(
            this.tokens.generateOpaqueToken(),
          ),
          ssoOnly: true,
          firstName: 'Compte',
          lastName: 'Trajelys',
          role: AdminRole.COMPANY_ADMIN,
          depotScope: [],
        },
        select: { id: true, status: true, deletedAt: true, companyId: true },
      });
      admin = cree;
      this.logger.log(
        `Administrateur créé par authentification unique Trajelys pour ${company.name}.`,
      );
    }

    await this.prisma.raw.admin.update({
      where: { id: admin.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    await this.recordSecurityEvent(company.id, SecurityEventType.LOGIN_SUCCESS, {
      adminId: admin.id,
      source: 'TRAJELYS_SSO',
    });

    return { adminId: admin.id, companyId: company.id };
  }

  /** Connexion directe : la porte d'un appelant qui peut garder les jetons. */
  async connecterParTrajelys(identite: {
    userId: string;
    email?: string;
  }): Promise<AuthTokensDto> {
    const { adminId } = await this.resoudreAdministrateurTrajelys(identite);
    return this.issueTokens(adminId, newId());
  }

  /**
   * ── Le passage d'une origine à l'autre ──────────────────────────────────
   * Trajelys vit sur `www.<domaine>`, ce tableau de bord sur `admin.<domaine>`.
   * Le navigateur interdit à l'un de poser la session de l'autre : des jetons
   * obtenus côté Trajelys y resteraient enfermés.
   *
   * D'où un code intermédiaire. Trajelys l'obtient, redirige le navigateur
   * avec, et le tableau de bord l'échange contre de vrais jetons DEPUIS SA
   * PROPRE ORIGINE — où il a le droit de les garder.
   *
   * Ce qui transite dans l'URL n'est donc ni le jeton Supabase du client, ni
   * un jeton de ce service : une valeur qui ne vaut qu'une fois, moins d'une
   * minute, et pour personne d'autre.
   */
  private static readonly PREFIXE_CODE = 'sso:trajelys:';

  /**
   * Durée de vie du code.
   *
   * Une minute : le temps d'une redirection, pas celui d'un copier-coller. Il
   * traverse l'historique du navigateur et les journaux d'un proxy ; plus il
   * vit, plus cette trace vaut quelque chose.
   */
  private static readonly CODE_TTL_S = 60;

  async emettreCodeTrajelys(identite: {
    userId: string;
    email?: string;
  }): Promise<{ code: string; expireDansSecondes: number }> {
    const { adminId } = await this.resoudreAdministrateurTrajelys(identite);

    // Aléa du générateur de jetons, pas un identifiant lisible : un code
    // devinable rendrait toute cette mécanique décorative.
    const code = this.tokens.generateOpaqueToken();
    await this.redis.setWithTtl(
      AdminAuthService.PREFIXE_CODE + code,
      adminId,
      AdminAuthService.CODE_TTL_S,
    );

    return { code, expireDansSecondes: AdminAuthService.CODE_TTL_S };
  }

  async echangerCodeTrajelys(code: string): Promise<AuthTokensDto> {
    // Lecture ET suppression en une opération : entre un `get` et un `del`,
    // deux requêtes concurrentes consommeraient le même code.
    const adminId = await this.redis.consommerUneFois(
      AdminAuthService.PREFIXE_CODE + code,
    );
    if (!adminId) {
      throw new UnauthorizedException('Code de connexion invalide ou expiré.');
    }

    // Le compte a pu être désactivé pendant la minute de vie du code. C'est
    // étroit, mais c'est exactement la fenêtre qu'exploiterait quelqu'un dont
    // l'accès vient d'être retiré.
    const admin = await this.prisma.raw.admin.findUnique({
      where: { id: adminId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!admin || admin.deletedAt || admin.status !== AdminStatus.ACTIVE) {
      throw new UnauthorizedException('Compte administrateur inactif.');
    }

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
