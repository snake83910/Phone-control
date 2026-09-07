import { Injectable, Logger } from '@nestjs/common';
import { Alert, Device, Session } from '@prisma/client';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Façade de diffusion temps réel.
 *
 * Les services métier dépendent de cette classe et non de la passerelle : une
 * diffusion ne doit jamais faire échouer l'écriture qui l'a déclenchée. Toutes
 * les méthodes avalent donc leurs erreurs, en les journalisant.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  alertCreated(alert: Alert): void {
    this.safeEmit(alert.companyId, 'alert.created', {
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      deviceId: alert.deviceId,
      userId: alert.userId,
      depotId: alert.depotId,
      createdAt: alert.createdAt,
    });
  }

  alertUpdated(alert: Alert): void {
    this.safeEmit(alert.companyId, 'alert.updated', {
      id: alert.id,
      status: alert.status,
      acknowledgedAt: alert.acknowledgedAt,
      resolvedAt: alert.resolvedAt,
    });
  }

  deviceUpdated(device: Pick<Device, 'id' | 'companyId' | 'state' | 'assetTag'> & {
    batteryLevel?: number | null;
    lastSeenAt?: Date | null;
    lastLatitude?: number | null;
    lastLongitude?: number | null;
  }): void {
    this.safeEmit(device.companyId, 'device.updated', {
      id: device.id,
      assetTag: device.assetTag,
      state: device.state,
      batteryLevel: device.batteryLevel ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
      latitude: device.lastLatitude ?? null,
      longitude: device.lastLongitude ?? null,
    });
  }

  sessionChanged(session: Session, reason: string): void {
    this.safeEmit(session.companyId, 'session.changed', {
      id: session.id,
      deviceId: session.deviceId,
      userId: session.userId,
      status: session.status,
      state: session.state,
      returnedAt: session.returnedAt,
      reason,
    });
  }

  /**
   * Image d'un partage d'ecran, adressee au seul administrateur qui l'a
   * demande.
   *
   * Elle ne passe par aucune ecriture : ni base, ni fichier, ni journal. Le
   * serveur la relaie et l'oublie. C'est ce qui distingue cet outil d'une
   * captation -- et ce que la table `screen_share_sessions` documente en ne
   * gardant que le contexte, jamais l'image.
   */
  screenShareFrame(
    adminId: string,
    payload: {
      sessionId: string;
      deviceId: string;
      image: string;
      width: number;
      height: number;
      capturedAt: string;
      sequence: number;
    },
  ): void {
    try {
      this.gateway.emitToAdmin(adminId, 'screen-share.frame', payload);
    } catch (err) {
      this.logger.warn(
        `Relais d'image impossible : ${(err as Error).message}`,
      );
    }
  }

  /** Changement d'etat d'un partage : reponse du chauffeur, fin, expiration. */
  screenShareChanged(
    adminId: string,
    companyId: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      this.gateway.emitToAdmin(adminId, 'screen-share.changed', payload);
    } catch (err) {
      this.logger.warn(
        `Diffusion screen-share.changed impossible : ${(err as Error).message}`,
      );
    }
    this.safeEmit(companyId, 'screen-share.changed', payload);
  }

  private safeEmit(companyId: string, event: string, payload: unknown): void {
    try {
      this.gateway.emitToCompany(companyId, event, payload);
    } catch (err) {
      this.logger.warn(
        `Diffusion ${event} impossible : ${(err as Error).message}`,
      );
    }
  }
}
