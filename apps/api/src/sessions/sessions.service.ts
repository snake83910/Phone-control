import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DeviceState,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
  SessionEndReason,
  SessionState,
  SessionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newId } from '../common/ids';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async findAll(params: {
    deviceId?: string;
    userId?: string;
    status?: SessionStatus;
    take: number;
    skip: number;
  }) {
    const where: Prisma.SessionWhereInput = {
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.status ? { status: params.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.db.session.findMany({
        where,
        take: params.take,
        skip: params.skip,
        orderBy: { startedAt: 'desc' },
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          device: { select: { id: true, assetTag: true } },
          depot: { select: { id: true, name: true } },
        },
      }),
      this.prisma.db.session.count({ where }),
    ]);

    return { items, total, take: params.take, skip: params.skip };
  }

  async findOne(id: string) {
    const session = await this.prisma.db.session.findFirst({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        device: { select: { id: true, assetTag: true } },
        depot: true,
      },
    });
    if (!session) throw new NotFoundException('Session introuvable.');
    return session;
  }

  /** Session active d'un appareil, ou null. */
  async currentForDevice(deviceId: string) {
    return this.prisma.raw.session.findFirst({
      where: { deviceId, status: SessionStatus.ACTIVE },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  /**
   * Clôture d'une session par un administrateur ou par une règle serveur.
   * Le téléphone en est informé par une commande, pas par cet appel : la base
   * ne peut pas pousser d'ordre toute seule.
   */
  async end(
    id: string,
    reason: SessionEndReason,
    actorAdminId?: string,
  ): Promise<void> {
    const session = await this.prisma.db.session.findFirst({ where: { id } });
    if (!session) throw new NotFoundException('Session introuvable.');
    if (session.status !== SessionStatus.ACTIVE) return;

    const now = new Date();
    const updated = await this.prisma.raw.$transaction(async (tx) => {
      const result = await tx.session.update({
        where: { id },
        data: {
          status:
            reason === SessionEndReason.REVOKED
              ? SessionStatus.REVOKED
              : SessionStatus.ENDED,
          endedAt: now,
          endReason: reason,
        },
      });
      await tx.device.update({
        where: { id: session.deviceId },
        data: { state: DeviceState.LOCKED },
      });
      await tx.securityEvent.create({
        data: {
          id: newId(),
          companyId: session.companyId,
          deviceId: session.deviceId,
          userId: session.userId,
          sessionId: session.id,
          type: SecurityEventType.SESSION_ENDED,
          severity: SecuritySeverity.LOW,
          occurredAt: now,
          metadata: { reason, actorAdminId: actorAdminId ?? null } as Prisma.InputJsonValue,
        },
      });

      return result;
    });

    this.realtime.sessionChanged(updated, reason);
  }

  /**
   * Expire les sessions dont la durée maximale est dépassée.
   * Appelée par le worker ; renvoie les sessions expirées pour que l'appelant
   * puisse émettre les commandes de verrouillage correspondantes.
   */
  async expireOverdue(now = new Date(), companyIds?: string[]) {
    const overdue = await this.prisma.raw.session.findMany({
      where: {
        status: SessionStatus.ACTIVE,
        expiresAt: { lt: now },
        ...(companyIds ? { companyId: { in: companyIds } } : {}),
      },
      select: { id: true, companyId: true, deviceId: true, userId: true },
    });

    if (overdue.length === 0) return [];

    await this.prisma.raw.$transaction([
      this.prisma.raw.session.updateMany({
        where: { id: { in: overdue.map((s) => s.id) } },
        data: {
          status: SessionStatus.EXPIRED,
          endedAt: now,
          endReason: SessionEndReason.EXPIRED,
        },
      }),
      // L'appareil passe en LOCKING, pas en LOCKED : le serveur a ordonné le
      // verrouillage, le téléphone ne l'a pas encore confirmé. Le laisser à
      // ACTIVE afficherait un porteur qui n'existe plus ; le passer à LOCKED
      // affirmerait un verrouillage non constaté.
      this.prisma.raw.device.updateMany({
        where: { id: { in: overdue.map((s) => s.deviceId) } },
        data: { state: DeviceState.LOCKING },
      }),
    ]);

    return overdue;
  }

  /** Marque une session comme retournée au dépôt (règle des 18h). */
  async markReturned(
    sessionId: string,
    at: Date,
    position: { latitude: number; longitude: number; accuracy?: number | null },
  ): Promise<void> {
    const session = await this.prisma.raw.session.update({
      where: { id: sessionId },
      data: {
        state: SessionState.RETURNED,
        returnedAt: at,
        returnedLatitude: position.latitude,
        returnedLongitude: position.longitude,
        returnedAccuracy: position.accuracy ?? null,
      },
    });
    this.realtime.sessionChanged(session, 'RETURNED');
  }
}
