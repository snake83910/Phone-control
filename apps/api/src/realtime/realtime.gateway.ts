import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AdminRole, AdminStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface AdminJwtPayload {
  sub: string;
  typ: 'admin';
  role: AdminRole;
  companyId: string | null;
}

/**
 * Flux temps réel du dashboard.
 *
 * Réservé aux navigateurs des administrateurs. Les téléphones n'ouvrent
 * délibérément aucune connexion permanente : sur une flotte de plusieurs
 * milliers d'appareils, le coût en batterie et en connexions serait sans
 * commune mesure avec le gain (cf. docs/02 §7).
 *
 * Cloisonnement : chaque socket rejoint la salle de son entreprise, et rien
 * d'autre. Une diffusion est donc toujours adressée à une salle nommée, jamais
 * au serveur entier.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.query?.token as string | undefined);

    if (!token) {
      client.disconnect(true);
      return;
    }

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      client.disconnect(true);
      return;
    }

    if (payload.typ !== 'admin') {
      client.disconnect(true);
      return;
    }

    // Relecture du compte : un administrateur désactivé ne doit pas conserver
    // un flux ouvert jusqu'à l'expiration de son jeton.
    const admin = await this.prisma.raw.admin.findUnique({
      where: { id: payload.sub },
      select: { id: true, companyId: true, role: true, status: true, deletedAt: true },
    });

    if (!admin || admin.deletedAt || admin.status !== AdminStatus.ACTIVE) {
      client.disconnect(true);
      return;
    }

    if (admin.companyId) {
      await client.join(companyRoom(admin.companyId));
    } else if (admin.role === AdminRole.SUPER_ADMIN) {
      await client.join('super-admin');
    } else {
      client.disconnect(true);
      return;
    }

    // Salle personnelle, en plus de celle de l'entreprise. Elle sert aux flux
    // qui ne concernent qu'un seul administrateur -- les images d'un partage
    // d'ecran, qui n'ont a etre vues que par celui qui l'a demande et dont la
    // demande est nominative.
    await client.join(adminRoom(admin.id));

    client.data.adminId = admin.id;
    client.data.companyId = admin.companyId;
    client.emit('connected', {
      companyId: admin.companyId,
      serverTime: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Déconnexion du flux temps réel : ${client.id}`);
  }

  emitToCompany(companyId: string, event: string, payload: unknown): void {
    // `server` est absent tant que la passerelle n'est pas initialisée
    // (tests unitaires, application sans adaptateur HTTP) : ne pas planter pour
    // autant, une notification manquée ne doit jamais casser une écriture.
    if (!this.server) return;
    this.server.to(companyRoom(companyId)).emit(event, payload);
    this.server.to('super-admin').emit(event, { companyId, ...(payload as object) });
  }

  /**
   * Diffusion a un seul administrateur.
   *
   * Deliberement SANS relais vers la salle super-admin, contrairement a
   * `emitToCompany` : un partage d'ecran est nominatif, et le voir passer sans
   * l'avoir demande n'aurait aucune trace attribuable a personne.
   */
  emitToAdmin(adminId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(adminRoom(adminId)).emit(event, payload);
  }
}

export function companyRoom(companyId: string): string {
  return `company:${companyId}`;
}

export function adminRoom(adminId: string): string {
  return `admin:${adminId}`;
}
