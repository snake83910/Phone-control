import { Injectable, NotFoundException } from '@nestjs/common';
import { DeviceEnrollmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface LiveDevicePosition {
  deviceId: string;
  assetTag: string;
  state: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: Date;
  batteryLevel: number | null;
  isOffline: boolean;
  depot: { id: string; name: string } | null;
  user: { id: string; firstName: string; lastName: string } | null;
  sessionState: string | null;
}

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Positions pour la carte.
   *
   * Lues sur les colonnes dénormalisées de `devices`, pas sur la table
   * d'événements : afficher quarante téléphones ne doit pas déclencher quarante
   * balayages d'une table de plusieurs centaines de millions de lignes.
   */
  async live(offlineAfterMinutes: number): Promise<LiveDevicePosition[]> {
    const threshold = new Date(Date.now() - offlineAfterMinutes * 60_000);

    const devices = await this.prisma.db.device.findMany({
      where: {
        deletedAt: null,
        enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
        lastLatitude: { not: null },
        lastLongitude: { not: null },
      },
      select: {
        id: true,
        assetTag: true,
        state: true,
        lastLatitude: true,
        lastLongitude: true,
        lastAccuracy: true,
        lastLocationAt: true,
        lastSeenAt: true,
        batteryLevel: true,
        depot: { select: { id: true, name: true } },
        sessions: {
          where: { status: 'ACTIVE' },
          take: 1,
          select: {
            state: true,
            user: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { assetTag: 'asc' },
    });

    return devices.map((d) => ({
      deviceId: d.id,
      assetTag: d.assetTag,
      state: d.state,
      latitude: d.lastLatitude!,
      longitude: d.lastLongitude!,
      accuracy: d.lastAccuracy,
      at: d.lastLocationAt!,
      batteryLevel: d.batteryLevel,
      isOffline: !d.lastSeenAt || d.lastSeenAt < threshold,
      depot: d.depot,
      user: d.sessions[0]?.user ?? null,
      sessionState: d.sessions[0]?.state ?? null,
    }));
  }

  /**
   * Trace d'un téléphone sur une plage horaire.
   *
   * La borne temporelle est obligatoire : `location_events` est partitionnée par
   * mois, et une requête sans borne balaierait toutes les partitions. Elle est
   * plafonnée à 7 jours — une trace plus longue relève de l'export, pas de
   * l'affichage.
   */
  async history(params: {
    deviceId: string;
    from: Date;
    to: Date;
    limit: number;
  }) {
    const device = await this.prisma.db.device.findFirst({
      where: { id: params.deviceId, deletedAt: null },
      select: { id: true, assetTag: true },
    });
    if (!device) throw new NotFoundException('Appareil introuvable.');

    const maxSpanMs = 7 * 86_400_000;
    const from = params.from;
    const to =
      params.to.getTime() - from.getTime() > maxSpanMs
        ? new Date(from.getTime() + maxSpanMs)
        : params.to;

    const points = await this.prisma.db.locationEvent.findMany({
      where: {
        deviceId: params.deviceId,
        recordedAt: { gte: from, lte: to },
      },
      select: {
        recordedAt: true,
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        speedMps: true,
        batteryLevel: true,
        isMock: true,
        insideGeofence: true,
      },
      orderBy: { recordedAt: 'asc' },
      take: params.limit,
    });

    const geofenceEvents = await this.prisma.db.geofenceEvent.findMany({
      where: {
        deviceId: params.deviceId,
        occurredAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        eventType: true,
        occurredAt: true,
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        confidence: true,
      },
      orderBy: { occurredAt: 'asc' },
    });

    return {
      device,
      from,
      to,
      truncated: points.length === params.limit,
      points,
      geofenceEvents,
    };
  }

  /** Événements de geofence d'une session, pour la page « alerte ». */
  async sessionTrail(sessionId: string) {
    const session = await this.prisma.db.session.findFirst({
      where: { id: sessionId },
      select: { id: true, startedAt: true, endedAt: true, deviceId: true },
    });
    if (!session) throw new NotFoundException('Session introuvable.');

    const where: Prisma.GeofenceEventWhereInput = { sessionId };
    return {
      session,
      events: await this.prisma.db.geofenceEvent.findMany({
        where,
        orderBy: { occurredAt: 'asc' },
      }),
    };
  }
}
