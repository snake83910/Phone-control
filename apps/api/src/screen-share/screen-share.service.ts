import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CommandType,
  ScreenShareSession,
  ScreenShareState,
  SessionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommandsService } from '../devices/commands.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../common/ids';
import {
  acceptsFrames,
  isTerminal,
  transition,
  type ScreenShareEvent,
} from './rules';

export interface ScreenShareView {
  id: string;
  deviceId: string;
  assetTag: string;
  state: ScreenShareState;
  reason: string;
  requestedAt: Date;
  respondedAt: Date | null;
  endedAt: Date | null;
  expiresAt: Date;
  frameCount: number;
  detail: string | null;
  driver: { id: string; firstName: string; lastName: string } | null;
  requestedBy: { id: string; firstName: string; lastName: string } | null;
}

/**
 * Partage d'ecran avec accord du chauffeur.
 *
 * Ce service applique une regle que rien d'autre ne garantit : **on ne regarde
 * l'ecran de personne sans que cette personne l'ait accepte, et jamais plus
 * longtemps que la duree prevue.**
 *
 * Trois choses qu'il ne fait pas, et qui sont aussi importantes que ce qu'il
 * fait :
 *
 * - il ne conserve **aucune image** ; les captures sont relayees puis oubliees ;
 * - il ne permet a personne d'ouvrir un partage sans motif ecrit ;
 * - il ne laisse aucune seance ouverte indefiniment.
 *
 * La verification d'echeance est faite a la LECTURE ([[refresh]]) et non par une
 * tache de fond. Une seance ne peut donc pas rester ouverte parce qu'un
 * ordonnanceur est tombe : la premiere requete qui la touche la ferme.
 */
@Injectable()
export class ScreenShareService {
  private readonly logger = new Logger(ScreenShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get responseTimeoutMs(): number {
    return (
      this.config.get<number>('SCREEN_SHARE_RESPONSE_TIMEOUT_SECONDS', 120) * 1000
    );
  }

  private get maxDurationMs(): number {
    return this.config.get<number>('SCREEN_SHARE_MAX_DURATION_SECONDS', 600) * 1000;
  }

  private get maxFrameBytes(): number {
    return this.config.get<number>('SCREEN_SHARE_MAX_FRAME_BYTES', 400_000);
  }

  /**
   * Demande de partage, emise par un administrateur.
   *
   * Le motif est obligatoire et part tel quel sur le telephone : le chauffeur
   * decide en sachant qui demande et pourquoi. Une demande sans motif serait
   * une demande a l'aveugle, et un accord donne a l'aveugle n'est pas un accord.
   */
  async request(params: {
    companyId: string;
    deviceId: string;
    adminId: string;
    reason: string;
  }): Promise<ScreenShareView> {
    const device = await this.prisma.db.device.findFirst({
      where: { id: params.deviceId, deletedAt: null },
    });
    if (!device) throw new NotFoundException('Téléphone introuvable.');

    // Une seule seance vivante par telephone. Deux partages simultanes
    // rendraient impossible de dire a qui l'ecran a ete montre.
    const ongoing = await this.findOngoing(params.deviceId);
    if (ongoing) {
      throw new BadRequestException(
        'Un partage est déjà en cours ou en attente de réponse sur ce téléphone.',
      );
    }

    // Le chauffeur en session est celui dont l'ecran sera vu. Le nommer ici
    // permet de repondre plus tard a « qui a vu l'ecran de qui ».
    const session = await this.prisma.db.session.findFirst({
      where: { deviceId: params.deviceId, status: SessionStatus.ACTIVE },
      orderBy: { startedAt: 'desc' },
    });

    const created = await this.prisma.db.screenShareSession.create({
      data: {
        id: newId(),
        companyId: params.companyId,
        deviceId: params.deviceId,
        userId: session?.userId ?? null,
        requestedBy: params.adminId,
        reason: params.reason.trim(),
        state: ScreenShareState.REQUESTED,
        expiresAt: new Date(Date.now() + this.responseTimeoutMs),
      },
    });

    const admin = await this.prisma.raw.admin.findUnique({
      where: { id: params.adminId },
      select: { firstName: true, lastName: true },
    });

    await this.commands.enqueue({
      companyId: params.companyId,
      deviceId: params.deviceId,
      command: CommandType.REQUEST_SCREEN_SHARE,
      payload: {
        sessionId: created.id,
        reason: created.reason,
        requestedBy: admin ? `${admin.firstName} ${admin.lastName}` : 'Exploitation',
        expiresAt: created.expiresAt.toISOString(),
      },
      // La commande ne survit pas a la demande : recevoir demain une invitation
      // a partager son ecran d'hier n'aurait aucun sens.
      ttlMinutes: Math.ceil(this.responseTimeoutMs / 60_000),
      createdBy: params.adminId,
      priority: 0,
    });

    await this.audit.record({
      action: 'ADMIN_REQUEST_SCREEN_SHARE',
      resourceType: 'screen_share_session',
      resourceId: created.id,
      after: {
        deviceId: params.deviceId,
        userId: created.userId,
        reason: created.reason,
      },
    });

    return this.toView(created);
  }

  /**
   * Reponse du chauffeur.
   *
   * C'est le seul point du systeme qui fait passer une seance a `ACCEPTED`, et
   * il n'est atteignable que par le telephone lui-meme, avec son propre jeton.
   * Aucun administrateur ne peut accorder cet accord a la place du chauffeur.
   */
  async recordConsent(
    deviceId: string,
    sessionId: string,
    accepted: boolean,
    detail?: string,
  ): Promise<ScreenShareView> {
    const current = await this.loadForDevice(deviceId, sessionId);

    const result = transition(
      current.state,
      accepted ? 'DRIVER_ACCEPTS' : 'DRIVER_REFUSES',
    );
    if (!result.applied) {
      throw new BadRequestException(result.refusal ?? 'Réponse sans effet.');
    }

    const now = new Date();
    const updated = await this.prisma.db.screenShareSession.update({
      where: { id: sessionId },
      data: {
        state: result.state,
        respondedAt: now,
        detail: detail?.slice(0, 500) ?? null,
        ...(accepted
          ? {
              startedAt: now,
              // L'echeance est REMPLACEE, pas prolongee : le delai de reponse
              // et la duree du partage sont deux limites distinctes, et
              // additionner la premiere a la seconde donnerait a un chauffeur
              // lent un partage plus long.
              expiresAt: new Date(now.getTime() + this.maxDurationMs),
            }
          : { endedAt: now }),
      },
    });

    await this.audit.record({
      action: accepted ? 'DRIVER_ACCEPT_SCREEN_SHARE' : 'DRIVER_REFUSE_SCREEN_SHARE',
      resourceType: 'screen_share_session',
      resourceId: sessionId,
      before: { state: current.state },
      after: { state: updated.state, detail: updated.detail },
    });

    this.broadcast(updated);
    return this.toView(updated);
  }

  /**
   * Fin de seance, quelle qu'en soit l'origine.
   *
   * Idempotente : arreter un partage deja termine ne produit ni erreur ni
   * effet. C'est ce qui arrive quand le chauffeur coupe au moment ou
   * l'administrateur ferme sa fenetre, et ce n'est la faute de personne.
   */
  async end(params: {
    sessionId: string;
    event: Extract<ScreenShareEvent, 'ADMIN_STOPS' | 'DRIVER_STOPS' | 'CAPTURE_FAILED'>;
    deviceId?: string;
    companyId?: string;
    detail?: string;
  }): Promise<ScreenShareView> {
    const current = params.deviceId
      ? await this.loadForDevice(params.deviceId, params.sessionId)
      : await this.loadForCompany(params.companyId!, params.sessionId);

    const result = transition(current.state, params.event);
    if (!result.applied) {
      if (result.refusal) throw new BadRequestException(result.refusal);
      return this.toView(current);
    }

    const updated = await this.prisma.db.screenShareSession.update({
      where: { id: params.sessionId },
      data: {
        state: result.state,
        endedAt: new Date(),
        ...(params.detail ? { detail: params.detail.slice(0, 500) } : {}),
      },
    });

    await this.audit.record({
      action: 'END_SCREEN_SHARE',
      resourceType: 'screen_share_session',
      resourceId: params.sessionId,
      before: { state: current.state },
      after: { state: updated.state, frameCount: updated.frameCount },
    });

    this.broadcast(updated);
    return this.toView(updated);
  }

  /**
   * Relais d'une image.
   *
   * Rien n'est ecrit hors le compteur : ni l'image, ni sa miniature, ni un
   * chemin de fichier. Le serveur transmet et oublie.
   */
  async relayFrame(params: {
    deviceId: string;
    sessionId: string;
    image: string;
    width: number;
    height: number;
    capturedAt?: string;
  }): Promise<{ ok: true; sequence: number }> {
    const session = await this.loadForDevice(params.deviceId, params.sessionId);

    const verdict = acceptsFrames(session.state, session.expiresAt, new Date());
    if (!verdict.ok) {
      // 403 et non 400 : ce n'est pas une requete mal formee, c'est une capture
      // qui n'a pas le droit d'exister. Le telephone doit arreter, pas reessayer.
      throw new ForbiddenException(verdict.refusal);
    }

    // La longueur en base64 majore la taille reelle : refuser large est ici
    // preferable a decoder pour mesurer juste.
    if (params.image.length > this.maxFrameBytes) {
      throw new BadRequestException(
        `Image trop volumineuse (${params.image.length} octets encodés). ` +
          'Réduisez la qualité de capture.',
      );
    }

    const updated = await this.prisma.db.screenShareSession.update({
      where: { id: params.sessionId },
      data: { frameCount: { increment: 1 } },
    });

    this.realtime.screenShareFrame(session.requestedBy, {
      sessionId: session.id,
      deviceId: session.deviceId,
      image: params.image,
      width: params.width,
      height: params.height,
      capturedAt: params.capturedAt ?? new Date().toISOString(),
      sequence: updated.frameCount,
    });

    return { ok: true, sequence: updated.frameCount };
  }

  /** Seance vue par le telephone : etat, echeance, motif. */
  async forDevice(deviceId: string, sessionId: string): Promise<ScreenShareView> {
    return this.toView(await this.loadForDevice(deviceId, sessionId));
  }

  /**
   * Seance en attente ou en cours sur ce telephone.
   *
   * Le telephone l'interroge au demarrage : une demande peut avoir ete emise
   * pendant qu'il etait hors reseau, et la commande peut s'etre perdue.
   */
  async currentForDevice(deviceId: string): Promise<ScreenShareView | null> {
    const ongoing = await this.findOngoing(deviceId);
    return ongoing ? this.toView(ongoing) : null;
  }

  async findOne(companyId: string, sessionId: string): Promise<ScreenShareView> {
    return this.toView(await this.loadForCompany(companyId, sessionId));
  }

  /**
   * Historique. C'est la piece qu'on presentera aux representants du personnel :
   * qui a demande a voir quel ecran, pourquoi, et ce qui a ete repondu.
   */
  async history(params: { deviceId?: string; take: number; skip: number }) {
    const where = params.deviceId ? { deviceId: params.deviceId } : {};
    const [items, total] = await Promise.all([
      this.prisma.db.screenShareSession.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        take: params.take,
        skip: params.skip,
        include: {
          device: { select: { assetTag: true } },
          user: { select: { id: true, firstName: true, lastName: true } },
          admin: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.db.screenShareSession.count({ where }),
    ]);

    return {
      items: items.map((s) => this.toView(s)),
      total,
      take: params.take,
      skip: params.skip,
    };
  }

  /**
   * Seance vivante d'un telephone, echeance appliquee au passage.
   *
   * Le controle d'echeance vit ici plutot que dans une tache planifiee : une
   * seance ne peut donc pas survivre parce qu'un ordonnanceur est tombe.
   */
  private async findOngoing(deviceId: string) {
    const candidate = await this.prisma.db.screenShareSession.findFirst({
      where: {
        deviceId,
        state: { in: [ScreenShareState.REQUESTED, ScreenShareState.ACCEPTED] },
      },
      orderBy: { requestedAt: 'desc' },
      include: {
        device: { select: { assetTag: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
        admin: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!candidate) return null;
    return this.refresh(candidate);
  }

  /** Ferme une seance dont l'echeance est passee, et la renvoie fermee. */
  private async refresh<T extends ScreenShareSession>(session: T): Promise<T | null> {
    if (isTerminal(session.state)) return null;
    if (Date.now() < session.expiresAt.getTime()) return session;

    const closed = await this.prisma.db.screenShareSession.update({
      where: { id: session.id },
      data: { state: ScreenShareState.EXPIRED, endedAt: new Date() },
    });
    this.logger.log(
      `Partage d'écran ${session.id} expiré après ${closed.frameCount} image(s).`,
    );
    this.broadcast(closed);
    return null;
  }

  private async loadForDevice(deviceId: string, sessionId: string) {
    const session = await this.prisma.raw.screenShareSession.findFirst({
      where: { id: sessionId, deviceId },
      include: {
        device: { select: { assetTag: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
        admin: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!session) throw new NotFoundException('Partage d’écran introuvable.');
    return session;
  }

  private async loadForCompany(companyId: string, sessionId: string) {
    const session = await this.prisma.db.screenShareSession.findFirst({
      where: { id: sessionId, companyId },
      include: {
        device: { select: { assetTag: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
        admin: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!session) throw new NotFoundException('Partage d’écran introuvable.');
    return session;
  }

  private broadcast(session: ScreenShareSession): void {
    this.realtime.screenShareChanged(session.requestedBy, session.companyId, {
      id: session.id,
      deviceId: session.deviceId,
      state: session.state,
      endedAt: session.endedAt,
      expiresAt: session.expiresAt,
      frameCount: session.frameCount,
      detail: session.detail,
    });
  }

  private toView(
    session: ScreenShareSession & {
      device?: { assetTag: string };
      user?: { id: string; firstName: string; lastName: string } | null;
      admin?: { id: string; firstName: string; lastName: string } | null;
    },
  ): ScreenShareView {
    return {
      id: session.id,
      deviceId: session.deviceId,
      assetTag: session.device?.assetTag ?? '',
      state: session.state,
      reason: session.reason,
      requestedAt: session.requestedAt,
      respondedAt: session.respondedAt,
      endedAt: session.endedAt,
      expiresAt: session.expiresAt,
      frameCount: session.frameCount,
      detail: session.detail,
      driver: session.user ?? null,
      requestedBy: session.admin ?? null,
    };
  }
}
