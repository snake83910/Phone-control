import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Alert, AlertSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EmailChannel,
  WebhookChannel,
  type NotificationChannel,
  type NotificationMessage,
} from './channels';
import {
  notificationConfigSchema,
  routeAlert,
  type NotificationConfig,
} from './routing';

/**
 * Envoi des alertes aux humains.
 *
 * La décision — qui, quand, et quand se taire — appartient à `routing.ts`, qui
 * est pur et testé sans réseau. Ici il reste la mécanique : lire la
 * configuration de l'entreprise, compter ce qui est déjà parti, appeler les
 * canaux, et noter le résultat.
 *
 * **Rien de ce qui se passe ici ne doit faire échouer une alerte.** Une alerte
 * enregistrée mais non notifiée reste visible dans le dashboard et dans le flux
 * temps réel ; une exception qui remonterait jusqu'au moteur d'alertes ferait
 * perdre les deux.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly channels: Record<string, NotificationChannel>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    /**
     * Canaux injectables : la porte d'entrée des tests, et plus tard d'un canal
     * SMS. `@Optional()` est nécessaire — sans lui, Nest cherche à résoudre ce
     * paramètre comme une dépendance et refuse de construire le service.
     */
    @Optional() channels?: Record<string, NotificationChannel>,
  ) {
    this.channels = channels ?? {
      webhook: new WebhookChannel(),
      email: new EmailChannel(
        this.config.get<string>('SMTP_URL'),
        this.config.get<string>('SMTP_FROM') ?? 'phone-control@localhost',
      ),
    };
  }

  /**
   * Configuration de notification d'une entreprise.
   *
   * Elle vit dans `Company.settings`, sous la clé `notifications`. Ce n'est pas
   * le même chemin que la configuration des téléphones (`DeviceSettings`), et
   * c'est voulu : les adresses de l'exploitation n'ont rien à faire dans ce qui
   * descend sur un terminal.
   */
  async configFor(companyId: string): Promise<NotificationConfig | null> {
    const company = await this.prisma.raw.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    });

    const raw = (company?.settings as Record<string, unknown> | null)?.notifications;
    if (!raw) return null;

    const parsed = notificationConfigSchema.safeParse(raw);
    if (!parsed.success) {
      // Une configuration fautive ne doit pas passer inaperçue : sans ce
      // journal, l'exploitation croirait être prévenue et ne le serait pas.
      this.logger.error(
        `Configuration de notification invalide pour l'entreprise ${companyId} : ` +
          parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; '),
      );
      return null;
    }
    return parsed.data;
  }

  /** Nombre d'alertes déjà notifiées dans l'heure écoulée. */
  private async sentInLastHour(companyId: string, now: Date): Promise<number> {
    return this.prisma.raw.alert.count({
      where: { companyId, notifiedAt: { gte: new Date(now.getTime() - 3_600_000) } },
    });
  }

  /**
   * Achemine une alerte. Ne lève jamais.
   *
   * Retourne le nombre de canaux servis, ce qui rend le comportement observable
   * par les tests sans avoir à espionner les journaux.
   */
  async dispatch(alert: Alert, now: Date = new Date()): Promise<number> {
    try {
      return await this.deliver(alert, now);
    } catch (error) {
      this.logger.error(
        `Notification de l'alerte ${alert.id} impossible : ${(error as Error).message}`,
      );
      return 0;
    }
  }

  private async deliver(alert: Alert, now: Date): Promise<number> {
    const config = await this.configFor(alert.companyId);

    const decision = routeAlert({
      alert: { type: alert.type, severity: alert.severity },
      config,
      now,
      sentInLastHour: await this.sentInLastHour(alert.companyId, now),
    });

    for (const { label, reason } of decision.suppressed) {
      this.logger.debug(`Alerte ${alert.id} non envoyée vers ${label} : ${reason}`);
    }

    if (decision.targets.length === 0) return 0;

    const message = await this.compose(alert);
    let delivered = 0;

    for (const target of decision.targets) {
      const channel = this.channels[target.channel];
      if (!channel?.configured) {
        this.logger.warn(
          `Canal ${target.channel} non configuré : alerte ${alert.id} non délivrée à ${target.label}.`,
        );
        continue;
      }

      const result = await channel.send(target.destination, message);
      if (result.ok) {
        delivered += 1;
      } else {
        this.logger.warn(
          `Échec de notification vers ${target.label} : ${result.detail ?? 'raison inconnue'}`,
        );
      }
    }

    if (delivered > 0) {
      await this.prisma.raw.alert.update({
        where: { id: alert.id },
        data: { notifiedAt: now },
      });
    }

    return delivered;
  }

  private async compose(alert: Alert): Promise<NotificationMessage> {
    const [company, device] = await Promise.all([
      this.prisma.raw.company.findUnique({
        where: { id: alert.companyId },
        select: { name: true },
      }),
      alert.deviceId
        ? this.prisma.raw.device.findUnique({
            where: { id: alert.deviceId },
            select: { assetTag: true },
          })
        : Promise.resolve(null),
    ]);

    const dashboardUrl = this.config.get<string>('DASHBOARD_URL');

    return {
      alertId: alert.id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      body: alert.message,
      companyName: company?.name ?? 'entreprise inconnue',
      deviceAssetTag: device?.assetTag ?? null,
      occurredAt: alert.createdAt,
      url: dashboardUrl ? `${dashboardUrl.replace(/\/+$/, '')}/alerts` : undefined,
    };
  }

  /** Utile aux tests et au diagnostic : quels canaux sont réellement prêts. */
  get readiness(): Record<string, boolean> {
    return Object.fromEntries(
      Object.entries(this.channels).map(([name, channel]) => [name, channel.configured]),
    );
  }
}

/** Réexporté pour que l'appelant n'ait pas à connaître le module de routage. */
export { AlertSeverity };
