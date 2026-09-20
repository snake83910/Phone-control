import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminRole, AdminStatus, DeviceEnrollmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import {
  AUTH_KIND,
  AuthKind,
  ROLES_KEY,
  AuthenticatedAdmin,
  AuthenticatedDevice,
} from './auth.decorators';

interface AdminJwtPayload {
  sub: string;
  typ: 'admin';
  role: AdminRole;
  companyId: string | null;
}

interface DeviceJwtPayload {
  sub: string;
  typ: 'device';
  companyId: string;
}

/**
 * Guard global unique. Il fait deux choses indissociables :
 *  1. il authentifie (administrateur, appareil, ou route publique) ;
 *  2. il RENSEIGNE LE CONTEXTE MULTI-ENTREPRISES, ce dont dépend l'extension
 *     Prisma pour filtrer toutes les requêtes.
 *
 * Les regrouper garantit qu'aucune route authentifiée ne peut s'exécuter sans
 * entreprise active : une route protégée mais hors contexte lèverait une
 * TenantIsolationError à la première requête, plutôt que de tout renvoyer.
 *
 * Sécurité par défaut : sans décorateur, une route exige un administrateur.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind =
      this.reflector.getAllAndOverride<AuthKind>(AUTH_KIND, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'admin';

    if (kind === 'public') return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      admin?: AuthenticatedAdmin;
      device?: AuthenticatedDevice;
    }>();

    const token = extractBearer(req.headers.authorization);
    if (!token) {
      throw new UnauthorizedException("Jeton d'authentification absent.");
    }

    if (kind === 'service') return this.authenticateService(token);

    return kind === 'device'
      ? this.authenticateDevice(token, req)
      : this.authenticateAdmin(token, req, context);
  }

  /**
   * Longueur minimale du jeton de service.
   *
   * Un jeton court est devinable, et celui-ci ouvre la création d'entreprises.
   * Le refuser vaut mieux que de l'accepter : une installation qui démarre
   * avec `changeme` doit tomber en panne bruyamment, pas fonctionner.
   */
  private static readonly LONGUEUR_MINIMALE_JETON_SERVICE = 32;

  /**
   * Trajelys, machine à machine.
   *
   * ── Pas de contexte d'entreprise ────────────────────────────────────────
   * Contrairement aux trois autres portes, celle-ci n'en ouvre aucun et
   * n'active pas `crossTenant`. Les routes concernées lisent par
   * `prisma.raw` en filtrant elles-mêmes sur l'entreprise : le jeton ne
   * porte donc aucun pouvoir de traverser le cloisonnement, il ouvre
   * seulement deux poignées de requêtes écrites à la main.
   *
   * ── Comparaison à temps constant ────────────────────────────────────────
   * Un `===` sur un secret se compare caractère par caractère et s'arrête au
   * premier écart : le temps de réponse révèle combien de caractères sont
   * justes, et un attaquant reconstruit le jeton octet par octet. La
   * différence de longueur reste observable — elle ne livre rien
   * d'exploitable, contrairement au préfixe.
   */
  private authenticateService(token: string): boolean {
    const attendu = this.config.get<string>('TRAJELYS_SERVICE_TOKEN')?.trim();

    if (!attendu) {
      // Absence délibérée : une installation qui ne vend pas le module n'a
      // aucune raison de porter ce secret.
      throw new UnauthorizedException(
        "L'intégration Trajelys n'est pas configurée sur cette installation.",
      );
    }

    if (attendu.length < AccessGuard.LONGUEUR_MINIMALE_JETON_SERVICE) {
      throw new UnauthorizedException(
        'Le jeton de service configuré est trop court pour être accepté.',
      );
    }

    const fourni = Buffer.from(token, 'utf8');
    const reference = Buffer.from(attendu, 'utf8');
    const valide =
      fourni.length === reference.length && timingSafeEqual(fourni, reference);

    if (!valide) throw new UnauthorizedException('Jeton de service invalide.');

    return true;
  }

  private async authenticateAdmin(
    token: string,
    req: { admin?: AuthenticatedAdmin },
    context: ExecutionContext,
  ): Promise<boolean> {
    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Jeton invalide ou expiré.');
    }

    if (payload.typ !== 'admin') {
      throw new UnauthorizedException("Type de jeton inadapté à cette route.");
    }

    // Le jeton est court (15 min) mais une désactivation doit être immédiate :
    // on relit l'administrateur à chaque requête. Le coût est un accès index.
    const admin = await this.prisma.raw.admin.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        companyId: true,
        depotScope: true,
        status: true,
        deletedAt: true,
      },
    });

    if (!admin || admin.deletedAt || admin.status !== AdminStatus.ACTIVE) {
      throw new UnauthorizedException('Compte administrateur inactif.');
    }

    const roles = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && roles.length > 0 && !roles.includes(admin.role)) {
      throw new ForbiddenException(
        `Rôle ${admin.role} insuffisant pour cette opération.`,
      );
    }

    req.admin = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      companyId: admin.companyId,
      depotScope: admin.depotScope,
    };

    const ctx = TenantContext.require();
    ctx.adminId = admin.id;
    ctx.role = admin.role;
    ctx.depotScope = admin.depotScope;
    ctx.companyId = admin.companyId;
    // Le SUPER_ADMIN n'est rattaché à aucune entreprise : il traverse le
    // cloisonnement, ce qui est précisément la définition de son rôle.
    ctx.crossTenant = admin.role === AdminRole.SUPER_ADMIN && admin.companyId === null;

    if (!ctx.crossTenant && !ctx.companyId) {
      throw new ForbiddenException(
        "Ce compte n'est rattaché à aucune entreprise : accès impossible.",
      );
    }

    return true;
  }

  private async authenticateDevice(
    token: string,
    req: { device?: AuthenticatedDevice },
  ): Promise<boolean> {
    let payload: DeviceJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<DeviceJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('DEVICE_JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException("Jeton d'appareil invalide ou expiré.");
    }

    if (payload.typ !== 'device') {
      throw new UnauthorizedException("Type de jeton inadapté à cette route.");
    }

    const device = await this.prisma.raw.device.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        companyId: true,
        depotId: true,
        enrollmentStatus: true,
        deletedAt: true,
      },
    });

    if (
      !device ||
      device.deletedAt ||
      device.enrollmentStatus !== DeviceEnrollmentStatus.ENROLLED
    ) {
      // Révocation immédiate : le prochain appel d'un téléphone révoqué échoue,
      // il se verrouille et efface son cache hors ligne.
      throw new UnauthorizedException('Appareil révoqué ou non enrôlé.');
    }

    req.device = {
      id: device.id,
      companyId: device.companyId,
      depotId: device.depotId,
    };

    const ctx = TenantContext.require();
    ctx.deviceId = device.id;
    ctx.companyId = device.companyId;
    ctx.crossTenant = false;

    return true;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}
