import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createPushTransport, type PushTransport, type WakePayload } from './fcm';

/**
 * Réveil d'un téléphone.
 *
 * Le service décide **s'il vaut la peine** d'envoyer un réveil ; le transport
 * décide comment. Cette séparation permet de tester la décision — la partie qui
 * a des conséquences — sans projet Firebase.
 *
 * Trois raisons de ne rien envoyer, et aucune n'est un échec :
 *  - l'appareil n'a pas de jeton FCM (terminal sans services Google) ;
 *  - un réveil vient d'être envoyé (voir [MIN_INTERVAL_MS]) ;
 *  - aucun transport n'est configuré.
 *
 * Dans les trois cas, le téléphone verra la commande à sa prochaine
 * synchronisation. Le sondage périodique est le canal fiable ; FCM n'est qu'un
 * raccourci.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly transport: PushTransport;

  /**
   * Intervalle minimal entre deux réveils d'un même appareil.
   *
   * Une rafale de commandes — verrouiller, synchroniser, verrouiller à nouveau —
   * ne doit pas produire une rafale de messages. Le premier réveil suffit : le
   * téléphone qui se synchronise récupère toute la file d'un coup.
   */
  static readonly MIN_INTERVAL_MS = 30_000;

  private readonly lastWake = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() transport?: PushTransport,
  ) {
    this.transport =
      transport ??
      createPushTransport(config.get<string>('FCM_SERVICE_ACCOUNT'), this.logger);
  }

  get configured(): boolean {
    return this.transport.configured;
  }

  /** Vrai si l'appareil a été réveillé assez récemment pour qu'on s'abstienne. */
  private throttled(deviceId: string, nowMs: number): boolean {
    const previous = this.lastWake.get(deviceId);
    return previous !== undefined && nowMs - previous < PushService.MIN_INTERVAL_MS;
  }

  /**
   * Réveille un appareil. Ne lève jamais.
   *
   * Retourne `true` si un message est réellement parti — ce que les tests
   * observent, plutôt que d'espionner les journaux.
   */
  async wake(
    deviceId: string,
    payload: WakePayload,
    nowMs: number = Date.now(),
  ): Promise<boolean> {
    try {
      if (!this.transport.configured) return false;
      if (this.throttled(deviceId, nowMs)) {
        this.logger.debug(`Réveil de ${deviceId} ignoré : un message vient de partir.`);
        return false;
      }

      const device = await this.prisma.raw.device.findUnique({
        where: { id: deviceId },
        select: { fcmToken: true, assetTag: true },
      });

      if (!device?.fcmToken) {
        // Terminal sans services Google, ou pas encore remonté de jeton.
        // Le sondage périodique fera le travail.
        return false;
      }

      // Marqué avant l'envoi : deux commandes simultanées ne doivent produire
      // qu'un seul message, même si le premier envoi est encore en vol.
      this.lastWake.set(deviceId, nowMs);

      const result = await this.transport.send(device.fcmToken, payload);
      if (!result.ok) {
        this.logger.warn(
          `Réveil de ${device.assetTag} non délivré : ${result.detail ?? 'raison inconnue'}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(`Réveil de ${deviceId} impossible : ${(error as Error).message}`);
      return false;
    }
  }

  /** Enregistre le jeton FCM remonté par un téléphone. */
  async registerToken(deviceId: string, fcmToken: string | undefined): Promise<void> {
    if (!fcmToken?.trim()) return;

    await this.prisma.raw.device.update({
      where: { id: deviceId },
      data: { fcmToken: fcmToken.trim() },
    });
  }

  /** Réinitialise l'étranglement. Réservé aux tests. */
  resetThrottle(): void {
    this.lastWake.clear();
  }
}
