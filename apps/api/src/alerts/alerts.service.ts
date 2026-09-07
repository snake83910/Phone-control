import { Injectable, Logger } from '@nestjs/common';
import {
  Alert,
  AlertSeverity,
  AlertStatus,
  AlertType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { newId } from '../common/ids';
import { RealtimeService } from '../realtime/realtime.service';

export interface RaiseAlertInput {
  companyId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  deviceId?: string | null;
  userId?: string | null;
  depotId?: string | null;
  sessionId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  context?: Record<string, unknown>;
  /**
   * Clé de déduplication. Tant qu'une alerte OUVERTE porte la même clé, aucune
   * nouvelle alerte n'est créée : un téléphone hors ligne depuis trois heures
   * produit UNE alerte, pas cent quatre-vingts.
   */
  dedupeKey?: string | null;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Ce service reçoit toujours un companyId issu d'une source vérifiée
   * (appareil authentifié, session, entité déjà chargée sous contexte). Il
   * utilise donc le client brut, y compris depuis les tâches système.
   */
  async raise(input: RaiseAlertInput): Promise<Alert> {
    const data: Prisma.AlertUncheckedCreateInput = {
      id: newId(),
      companyId: input.companyId,
      deviceId: input.deviceId ?? null,
      userId: input.userId ?? null,
      depotId: input.depotId ?? null,
      sessionId: input.sessionId ?? null,
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      context: (input.context ?? {}) as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey ?? null,
      status: AlertStatus.OPEN,
    };

    // Vérification préalable : la contrainte en base reste l'autorité, mais la
    // consulter d'abord évite d'enregistrer une erreur PostgreSQL à chaque
    // alerte dédupliquée — un journal qui crie « erreur » sur un comportement
    // nominal finit par être ignoré.
    if (input.dedupeKey) {
      const open = await this.prisma.raw.alert.findFirst({
        where: {
          companyId: input.companyId,
          dedupeKey: input.dedupeKey,
          status: AlertStatus.OPEN,
        },
      });
      if (open) return open;
    }

    try {
      const created = await this.prisma.raw.alert.create({ data });
      // Le dashboard voit l'alerte apparaître sans rafraîchir la page :
      // sur une sortie après retour, chaque minute compte.
      this.realtime.alertCreated(created);

      // Notification aux humains : volontairement NON attendue. Un webhook lent
      // ou un relais SMTP injoignable ne doit pas retarder la réponse à
      // l'appareil qui vient de remonter l'événement — ni la faire échouer.
      // `dispatch` ne lève jamais ; l'alerte reste de toute façon visible dans
      // le dashboard et dans le flux temps réel.
      void this.notifications.dispatch(created);

      return created;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        input.dedupeKey
      ) {
        const existing = await this.prisma.raw.alert.findFirst({
          where: {
            companyId: input.companyId,
            dedupeKey: input.dedupeKey,
            status: AlertStatus.OPEN,
          },
        });
        if (existing) {
          this.logger.debug(
            `Alerte ${input.type} déjà ouverte (${input.dedupeKey}) : non dupliquée.`,
          );
          return existing;
        }
      }
      throw err;
    }
  }

  async acknowledge(
    alertId: string,
    adminId: string,
  ): Promise<Alert> {
    const alert = await this.prisma.db.alert.update({
      where: { id: alertId },
      data: {
        status: AlertStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedBy: adminId,
      },
    });
    this.realtime.alertUpdated(alert);
    return alert;
  }

  async resolve(
    alertId: string,
    adminId: string,
    note?: string,
  ): Promise<Alert> {
    const alert = await this.prisma.db.alert.update({
      where: { id: alertId },
      data: {
        status: AlertStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy: adminId,
        resolutionNote: note ?? null,
      },
    });
    this.realtime.alertUpdated(alert);
    return alert;
  }
}
