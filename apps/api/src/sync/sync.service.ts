import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertSeverity,
  AlertType,
  BadgeStatus,
  Depot,
  Device,
  GeofenceEventType,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
  SessionState,
  SessionStatus,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { SessionsService } from '../sessions/sessions.service';
import { CommandsService } from '../devices/commands.service';
import { BadgeHashService } from '../crypto/badge-hash.service';
import { BadgeCipherService } from '../crypto/badge-cipher.service';
import { ConfigService } from '@nestjs/config';
import { newId } from '../common/ids';
import { toBuffer } from '../common/bytes';
import { RealtimeService } from '../realtime/realtime.service';
import {
  evaluateGeofenceTransition,
  TransitionKind,
} from '../rules/geofence-rules';
import { DepotSchedule, formatInDepotZone } from '../rules/schedule';
import { SyncEventDto, SyncEventKind } from './dto/sync.dto';

export interface SyncPushResult {
  ackedEventIds: string[];
  rejected: Array<{ eventId: string; reason: string }>;
  serverTime: string;
  nextBackoffMs: number;
}

/**
 * Moteur de synchronisation côté serveur (docs/05 §4).
 *
 * Trois garanties, dans cet ordre d'importance :
 *  1. IDEMPOTENCE — un lot rejoué ne crée aucun doublon (event_id unique) ;
 *  2. ACQUITTEMENT EXPLICITE — le téléphone ne purge sa file qu'après ack ;
 *  3. AUTORITÉ SERVEUR — les règles horaires sont réévaluées ici, et le
 *     serveur corrige l'état de la session si le téléphone a divergé.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly sessions: SessionsService,
    private readonly commands: CommandsService,
    private readonly badgeHash: BadgeHashService,
    private readonly badgeCipher: BadgeCipherService,
    private readonly realtime: RealtimeService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Tolérance sur l'horloge des téléphones.
   *
   * Un appareil dont l'horloge avance date ses événements dans le futur. On les
   * accepte — une preuve horodatée de travers reste une preuve — mais on les
   * marque, pour qu'une alerte contestée puisse l'être en connaissance de cause
   * (docs/05, résolution des conflits).
   */
  private get clockToleranceMs(): number {
    return (this.config.get<number>('CLOCK_SKEW_TOLERANCE_SECONDS') ?? 300) * 1000;
  }

  /** Vrai si l'appareil a daté cet événement dans le futur, au-delà de la tolérance. */
  private isClockSuspect(occurredAt: Date, receivedAt: Date): boolean {
    return occurredAt.getTime() - receivedAt.getTime() > this.clockToleranceMs;
  }

  async push(deviceId: string, events: SyncEventDto[]): Promise<SyncPushResult> {
    const device = await this.prisma.raw.device.findUnique({
      where: { id: deviceId },
      include: { depot: true },
    });
    if (!device) throw new NotFoundException('Appareil introuvable.');

    const acked: string[] = [];
    const rejected: Array<{ eventId: string; reason: string }> = [];

    // Les événements de sécurité et de geofence sont traités avant les
    // positions : une alerte ne doit jamais attendre derrière 4 000 points GPS.
    const ordered = [...events].sort(
      (a, b) => priority(a.kind) - priority(b.kind) || a.seq - b.seq,
    );

    const locations = ordered.filter((e) => e.kind === SyncEventKind.LOCATION);
    const others = ordered.filter((e) => e.kind !== SyncEventKind.LOCATION);

    for (const event of others) {
      try {
        await this.handleSingle(device, event);
        acked.push(event.eventId);
      } catch (err) {
        this.logger.error(
          `Événement ${event.eventId} (${event.kind}) rejeté : ${(err as Error).message}`,
        );
        rejected.push({ eventId: event.eventId, reason: 'PROCESSING_ERROR' });
      }
    }

    if (locations.length > 0) {
      const inserted = await this.insertLocations(device, locations);
      acked.push(...inserted);
    }

    await this.reportClockSkew(device, events);

    return {
      ackedEventIds: acked,
      rejected,
      serverTime: new Date().toISOString(),
      nextBackoffMs: 0,
    };
  }

  /**
   * Horloge de l'appareil manifestement fausse.
   *
   * Le téléphone signale déjà sa propre dérive lorsqu'il la constate
   * (`CLOCK_TAMPERING`, docs/05 §4). Mais un terminal dont on a reculé l'horloge
   * pour échapper à la règle des 22 h n'a aucune raison de le déclarer : c'est
   * au serveur, qui détient l'heure de référence, de le voir arriver.
   *
   * Une alerte plutôt qu'un simple événement, et une clé de déduplication : un
   * téléphone à l'horloge faussée synchronise toutes les quinze minutes, et
   * quatre-vingt-seize alertes par jour ne se lisent pas.
   */
  private async reportClockSkew(device: Device, events: SyncEventDto[]): Promise<void> {
    const receivedAt = new Date();
    const skews = events
      .map((event) => new Date(event.occurredAt).getTime() - receivedAt.getTime())
      .filter((skew) => skew > this.clockToleranceMs);

    if (skews.length === 0) return;

    const worstMinutes = Math.round(Math.max(...skews) / 60_000);

    await this.recordSecurityEvent(device, {
      type: SecurityEventType.CLOCK_TAMPERING,
      severity: SecuritySeverity.HIGH,
      occurredAt: receivedAt,
      metadata: { events: skews.length, aheadByMinutes: worstMinutes },
    });

    await this.alerts.raise({
      companyId: device.companyId,
      deviceId: device.id,
      depotId: device.depotId,
      type: AlertType.DEVICE_TAMPERING,
      severity: AlertSeverity.HIGH,
      title: 'Horloge du téléphone incohérente',
      message:
        `${device.assetTag} a transmis ${skews.length} événement(s) datés jusqu'à ` +
        `${worstMinutes} minutes dans le futur. Les règles horaires du dépôt ` +
        `reposent sur cette horloge.`,
      dedupeKey: `clock-tampering:${device.id}`,
    });
  }

  // -------------------------------------------------------------------------

  private async insertLocations(
    device: Device,
    events: SyncEventDto[],
  ): Promise<string[]> {
    const session = await this.prisma.raw.session.findFirst({
      where: { deviceId: device.id, status: SessionStatus.ACTIVE },
      select: { id: true, userId: true },
    });

    const receivedAt = new Date();
    const rows: Prisma.LocationEventCreateManyInput[] = [];
    for (const e of events) {
      if (e.latitude == null || e.longitude == null) continue;
      rows.push({
        id: newId(),
        eventId: e.eventId,
        companyId: device.companyId,
        deviceId: device.id,
        sessionId: e.sessionId ?? session?.id ?? null,
        userId: session?.userId ?? null,
        depotId: e.depotId ?? device.depotId,
        recordedAt: new Date(e.occurredAt),
        latitude: e.latitude,
        longitude: e.longitude,
        accuracyMeters: e.accuracyMeters ?? null,
        altitude: e.altitude ?? null,
        speedMps: e.speedMps ?? null,
        bearing: e.bearing ?? null,
        provider: e.provider ?? null,
        isMock: e.isMock ?? false,
        batteryLevel: e.batteryLevel ?? null,
        insideGeofence: e.insideGeofence ?? null,
        clockSuspect: this.isClockSuspect(new Date(e.occurredAt), receivedAt),
      });
    }

    if (rows.length === 0) return [];

    // skipDuplicates => ON CONFLICT DO NOTHING : le rejeu d'un lot est inoffensif.
    await this.prisma.raw.locationEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });

    // Position simulée : signal de fraude, jamais silencieux.
    const mocked = rows.filter((r) => r.isMock);
    if (mocked.length > 0) {
      await this.recordSecurityEvent(device, {
        type: SecurityEventType.MOCK_LOCATION,
        severity: SecuritySeverity.HIGH,
        occurredAt: new Date(),
        metadata: { count: mocked.length },
      });
      await this.alerts.raise({
        companyId: device.companyId,
        deviceId: device.id,
        depotId: device.depotId,
        type: AlertType.DEVICE_TAMPERING,
        severity: AlertSeverity.HIGH,
        title: 'Position simulée détectée',
        message: `${device.assetTag} a transmis ${mocked.length} position(s) marquée(s) comme simulée(s).`,
        dedupeKey: `mock-location:${device.id}`,
      });
    }

    // Dénormalisation de la dernière position, pour la carte du dashboard.
    const latest = rows.reduce((a, b) =>
      (a.recordedAt as Date) > (b.recordedAt as Date) ? a : b,
    );
    if (
      !device.lastLocationAt ||
      (latest.recordedAt as Date) > device.lastLocationAt
    ) {
      const updated = await this.prisma.raw.device.update({
        where: { id: device.id },
        data: {
          lastLatitude: latest.latitude,
          lastLongitude: latest.longitude,
          lastAccuracy: latest.accuracyMeters ?? null,
          lastLocationAt: latest.recordedAt as Date,
          lastSyncAt: new Date(),
        },
      });
      // La carte du dashboard suit le déplacement sans interrogation périodique.
      this.realtime.deviceUpdated(updated);
    }

    return rows.map((r) => r.eventId as string);
  }

  private async handleSingle(
    device: Device & { depot: Depot | null },
    event: SyncEventDto,
  ): Promise<void> {
    switch (event.kind) {
      case SyncEventKind.GEOFENCE:
        return this.handleGeofence(device, event);
      case SyncEventKind.SECURITY:
        return this.handleSecurity(device, event);
      case SyncEventKind.BARCODE_SCAN:
        return this.handleOfflineScan(device, event);
      default:
        return;
    }
  }

  /**
   * Application des règles horaires à une transition confirmée par le moteur
   * local. Le serveur ne réévalue pas la géométrie : il fait autorité sur
   * l'HEURE et sur la configuration du dépôt (docs/06 §5).
   */
  private async handleGeofence(
    device: Device & { depot: Depot | null },
    event: SyncEventDto,
  ): Promise<void> {
    const existing = await this.prisma.raw.geofenceEvent.findUnique({
      where: { eventId: event.eventId },
      select: { id: true },
    });
    if (existing) return; // déjà traité : rejeu inoffensif

    const depot = device.depot;
    if (!depot) {
      this.logger.warn(
        `Événement de geofence reçu de ${device.assetTag}, sans dépôt rattaché : ignoré.`,
      );
      return;
    }

    const session = await this.prisma.raw.session.findFirst({
      where: { deviceId: device.id, status: SessionStatus.ACTIVE },
    });

    const occurredAt = new Date(event.occurredAt);
    const transition: TransitionKind =
      event.geofenceEventType === GeofenceEventType.EXIT_DEPOT ||
      event.geofenceEventType === GeofenceEventType.AFTER_RETURN_EXIT
        ? 'EXIT'
        : 'ENTER';

    const schedule = toSchedule(depot);
    const decision = evaluateGeofenceTransition({
      transition,
      occurredAt,
      schedule,
      sessionState: (session?.state ?? SessionState.ACTIVE) as 'ACTIVE' | 'RETURNED',
    });

    // Divergence entre la décision locale et celle du serveur : on la trace,
    // et c'est le serveur qui l'emporte.
    if (
      event.geofenceEventType &&
      event.geofenceEventType !== decision.eventType
    ) {
      this.logger.warn(
        `Divergence de décision pour ${device.assetTag} : appareil=${event.geofenceEventType}, ` +
          `serveur=${decision.eventType} (${formatInDepotZone(schedule, occurredAt)}).`,
      );
    }

    const geofenceEventId = newId();
    let alertId: string | null = null;

    if (decision.alert) {
      const alert = await this.alerts.raise({
        companyId: device.companyId,
        deviceId: device.id,
        userId: session?.userId ?? null,
        depotId: depot.id,
        sessionId: session?.id ?? null,
        type: AlertType.AFTER_RETURN_EXIT,
        severity: AlertSeverity.HIGH,
        title: decision.alert.title,
        message: buildAfterReturnMessage(device, depot, session?.returnedAt ?? null, occurredAt, schedule),
        latitude: event.latitude ?? null,
        longitude: event.longitude ?? null,
        context: {
          assetTag: device.assetTag,
          depot: depot.name,
          returnedAt: session?.returnedAt ?? null,
          exitedAt: occurredAt,
          localTime: formatInDepotZone(schedule, occurredAt),
          confidence: event.confidence ?? 1,
        },
        // Une seule alerte par sortie effective : une reconnexion qui rejoue le
        // même événement ne doit pas en créer une seconde.
        dedupeKey: `after-return-exit:${session?.id ?? device.id}`,
      });
      alertId = alert.id;
    }

    const outcome = await this.prisma.raw.$transaction(async (tx) => {
      await tx.geofenceEvent.create({
        data: {
          id: geofenceEventId,
          eventId: event.eventId,
          companyId: device.companyId,
          deviceId: device.id,
          userId: session?.userId ?? null,
          sessionId: session?.id ?? null,
          depotId: depot.id,
          eventType: decision.eventType as GeofenceEventType,
          occurredAt,
          latitude: event.latitude ?? depot.latitude,
          longitude: event.longitude ?? depot.longitude,
          accuracyMeters: event.accuracyMeters ?? null,
          confidence: event.confidence ?? 1,
          evaluation: (event.evaluation ?? {}) as Prisma.InputJsonValue,
          createdAlertId: alertId,
          clockSuspect: this.isClockSuspect(occurredAt, new Date()),
        },
      });

      let updatedSession = null;
      if (session) {
        updatedSession = await tx.session.update({
          where: { id: session.id },
          data: {
            state: decision.nextSessionState as SessionState,
            ...(decision.markReturned
              ? {
                  returnedAt: occurredAt,
                  returnedLatitude: event.latitude ?? depot.latitude,
                  returnedLongitude: event.longitude ?? depot.longitude,
                  returnedAccuracy: event.accuracyMeters ?? null,
                }
              : {}),
          },
        });
        await tx.device.update({
          where: { id: device.id },
          data: {
            state:
              decision.nextSessionState === 'RETURNED' ? 'RETURNED' : 'ACTIVE',
          },
        });
      }

      await tx.securityEvent.create({
        data: {
          id: newId(),
          companyId: device.companyId,
          deviceId: device.id,
          userId: session?.userId ?? null,
          sessionId: session?.id ?? null,
          type:
            decision.eventType === 'AFTER_RETURN_EXIT'
              ? SecurityEventType.AFTER_RETURN_EXIT
              : transition === 'ENTER'
                ? SecurityEventType.ENTER_DEPOT
                : SecurityEventType.EXIT_DEPOT,
          severity:
            decision.eventType === 'AFTER_RETURN_EXIT'
              ? SecuritySeverity.HIGH
              : SecuritySeverity.LOW,
          occurredAt,
          metadata: {
            reason: decision.reason,
            depot: depot.name,
            localTime: formatInDepotZone(schedule, occurredAt),
          } as Prisma.InputJsonValue,
        },
      });

      return updatedSession;
    });

    if (outcome) {
      this.realtime.sessionChanged(outcome, decision.eventType);
    }
  }

  private async handleSecurity(
    device: Device,
    event: SyncEventDto,
  ): Promise<void> {
    if (!event.securityType) return;

    await this.prisma.raw.securityEvent.createMany({
      data: [
        {
          id: newId(),
          eventId: event.eventId,
          companyId: device.companyId,
          deviceId: device.id,
          sessionId: event.sessionId ?? null,
          type: event.securityType,
          severity: event.severity ?? SecuritySeverity.LOW,
          occurredAt: new Date(event.occurredAt),
          metadata: (event.metadata ?? {}) as Prisma.InputJsonValue,
          clockSuspect: this.isClockSuspect(new Date(event.occurredAt), new Date()),
        },
      ],
      skipDuplicates: true,
    });

    const critical: SecurityEventType[] = [
      SecurityEventType.ROOT_DETECTED,
      SecurityEventType.DEVICE_OWNER_LOST,
      SecurityEventType.APP_INTEGRITY_FAILED,
      SecurityEventType.CLOCK_TAMPERING,
      SecurityEventType.KIOSK_EXIT_ATTEMPT,
    ];

    if (critical.includes(event.securityType)) {
      await this.alerts.raise({
        companyId: device.companyId,
        deviceId: device.id,
        depotId: device.depotId,
        type: AlertType.DEVICE_TAMPERING,
        severity: AlertSeverity.CRITICAL,
        title: `Événement de sécurité : ${event.securityType}`,
        message: `${device.assetTag} a signalé ${event.securityType}.`,
        dedupeKey: `security:${device.id}:${event.securityType}`,
        context: event.metadata ?? {},
      });
    }
  }

  /**
   * Scan réalisé hors ligne, remonté a posteriori.
   * C'est ici que la session ouverte sans le serveur est REVALIDÉE : si le
   * badge a été révoqué entre-temps, la session est révoquée et le téléphone
   * reçoit l'ordre de se verrouiller.
   */
  private async handleOfflineScan(
    device: Device,
    event: SyncEventDto,
  ): Promise<void> {
    await this.prisma.raw.barcodeScanEvent.createMany({
      data: [
        {
          id: newId(),
          eventId: event.eventId,
          companyId: device.companyId,
          deviceId: device.id,
          sessionId: event.sessionId ?? null,
          result: 'OFFLINE_GRANTED',
          scannedAt: new Date(event.occurredAt),
          latitude: event.latitude ?? null,
          longitude: event.longitude ?? null,
          offline: true,
          clockSuspect: this.isClockSuspect(new Date(event.occurredAt), new Date()),
        },
      ],
      skipDuplicates: true,
    });

    if (!event.sessionId) return;

    const session = await this.prisma.raw.session.findFirst({
      where: { id: event.sessionId, deviceId: device.id },
      include: { badge: true, user: true },
    });
    if (!session || session.status !== SessionStatus.ACTIVE) return;

    const badgeStillValid =
      session.badge?.status === BadgeStatus.ACTIVE &&
      session.user.status === UserStatus.ACTIVE;

    if (badgeStillValid) {
      await this.prisma.raw.session.update({
        where: { id: session.id },
        data: { offlineValidatedAt: new Date() },
      });
      return;
    }

    await this.sessions.end(session.id, 'OFFLINE_REVALIDATION_FAILED');
    await this.commands.enqueue({
      companyId: device.companyId,
      deviceId: device.id,
      command: 'LOCK_DEVICE',
      createdBy: null,
      idempotencyKey: `offline-revalidation:${session.id}`,
      priority: 100,
    });
    await this.alerts.raise({
      companyId: device.companyId,
      deviceId: device.id,
      userId: session.userId,
      depotId: device.depotId,
      type: AlertType.UNAUTHORIZED_USER,
      severity: AlertSeverity.HIGH,
      title: 'Session hors ligne invalidée',
      message:
        `${device.assetTag} : la session ouverte hors ligne par ` +
        `${session.user.firstName} ${session.user.lastName} a été révoquée — ` +
        `badge ou compte désactivé entre-temps.`,
      dedupeKey: `offline-revalidation:${session.id}`,
    });
  }

  private async recordSecurityEvent(
    device: Device,
    params: {
      type: SecurityEventType;
      severity: SecuritySeverity;
      occurredAt: Date;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.prisma.raw.securityEvent.create({
      data: {
        id: newId(),
        companyId: device.companyId,
        deviceId: device.id,
        type: params.type,
        severity: params.severity,
        occurredAt: params.occurredAt,
        metadata: params.metadata as Prisma.InputJsonValue,
      },
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Configuration, listes et commandes attendues par l'appareil.
   * La configuration n'est renvoyée que si sa version a changé : sur une flotte
   * de milliers de terminaux, renvoyer tout à chaque cycle serait du gâchis.
   */
  async pull(deviceId: string, knownConfigVersion?: number) {
    const device = await this.prisma.raw.device.findUnique({
      where: { id: deviceId },
      include: { depot: { include: { geofences: true } } },
    });
    if (!device) throw new NotFoundException('Appareil introuvable.');

    const settings = await this.settings.resolveForDevice(
      device.companyId,
      device.id,
      device.depotId,
    );
    const configChanged = knownConfigVersion !== settings.version;

    const commands = await this.commands.pullPending(device.id);
    const session = await this.sessions.currentForDevice(device.id);

    await this.prisma.raw.device.update({
      where: { id: device.id },
      data: { lastSyncAt: new Date(), lastSeenAt: new Date() },
    });

    return {
      serverTime: new Date().toISOString(),
      configVersion: settings.version,
      settings: configChanged ? settings : null,
      depot:
        configChanged && device.depot
          ? {
              id: device.depot.id,
              name: device.depot.name,
              latitude: device.depot.latitude,
              longitude: device.depot.longitude,
              radiusMeters: device.depot.radiusMeters,
              exitHysteresisMeters: device.depot.exitHysteresisMeters,
              timezone: device.depot.timezone,
              returnTime: device.depot.returnTime,
              lockTime: device.depot.lockTime,
              operationalDayStart: device.depot.operationalDayStart,
              scheduleOverrides: device.depot.scheduleOverrides,
              wifiHints: device.depot.wifiHints,
              geofences: device.depot.geofences.map((g) => ({
                id: g.id,
                latitude: g.latitude,
                longitude: g.longitude,
                radiusMeters: g.radiusMeters,
                hysteresisMeters: g.hysteresisMeters,
                minDwellSeconds: g.minDwellSeconds,
              })),
            }
          : null,
      offlineBadges: settings.offlineAuthEnabled
        ? await this.buildOfflineBadgeList(device, settings.offlineCacheMaxAgeMinutes)
        : [],
      commands: commands.map((c) => ({
        id: c.id,
        command: c.command,
        payload: c.payload,
        expiresAt: c.expiresAt,
      })),
      session: session
        ? {
            id: session.id,
            userId: session.userId,
            state: session.state,
            expiresAt: session.expiresAt,
            returnedAt: session.returnedAt,
            user: session.user,
          }
        : null,
    };
  }

  /**
   * Liste d'authentification hors ligne (docs/05 §3.1).
   *
   * Elle ne contient JAMAIS les valeurs de badge, mais des empreintes calculées
   * avec la clé propre à CET appareil. Extraite d'un téléphone volé, elle est
   * inutilisable ailleurs. Elle se limite aux chauffeurs réellement affectés à
   * ce téléphone, ce qui applique aussi hors ligne la règle « ce téléphone
   * n'est pas autorisé pour cet utilisateur ».
   */
  private async buildOfflineBadgeList(device: Device, maxAgeMinutes: number) {
    const deviceKey = this.badgeHash.deriveDeviceKey(device.id);
    const now = new Date();

    const assignments = await this.prisma.raw.deviceAssignment.findMany({
      where: {
        deviceId: device.id,
        revokedAt: null,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gt: now } }],
      },
      include: {
        user: {
          include: {
            badges: { where: { status: BadgeStatus.ACTIVE } },
          },
        },
      },
    });

    const validUntil = new Date(now.getTime() + maxAgeMinutes * 60_000);

    if (!this.badgeCipher.enabled) {
      // Sans clé de chiffrement, le serveur ne peut pas recalculer les
      // empreintes propres à l'appareil : on renvoie une liste vide plutôt
      // qu'une liste inexploitable, et on le dit.
      this.logger.warn(
        `Liste hors ligne vide pour ${device.assetTag} : BADGE_ENCRYPTION_KEY non configurée.`,
      );
      return [];
    }

    const entries: Array<{
      userId: string;
      firstName: string;
      lastName: string;
      badgeHmac: string;
      badgeLast4: string;
      validUntil: string;
    }> = [];

    for (const assignment of assignments) {
      const user = assignment.user;
      if (user.status !== UserStatus.ACTIVE || user.deletedAt) continue;

      for (const badge of user.badges) {
        const normalized = this.badgeCipher.decrypt(
          toBuffer(badge.barcodeCiphertext),
        );
        if (!normalized) {
          this.logger.warn(
            `Badge ${badge.id} sans valeur déchiffrable : exclu de la liste hors ligne.`,
          );
          continue;
        }
        entries.push({
          userId: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          // Empreinte que CE téléphone, et lui seul, saura recalculer à partir
          // du code scanné et de sa clé Keystore.
          badgeHmac: this.badgeHash.deviceScopedHash(deviceKey, normalized),
          badgeLast4: badge.barcodeLast4,
          validUntil: validUntil.toISOString(),
        });
      }
    }

    return entries;
  }
}

function priority(kind: SyncEventKind): number {
  switch (kind) {
    case SyncEventKind.SECURITY:
      return 0;
    case SyncEventKind.GEOFENCE:
      return 1;
    case SyncEventKind.BARCODE_SCAN:
      return 2;
    default:
      return 3;
  }
}

function toSchedule(depot: Depot): DepotSchedule {
  return {
    timezone: depot.timezone,
    returnTime: depot.returnTime,
    lockTime: depot.lockTime,
    operationalDayStart: depot.operationalDayStart,
    overrides: depot.scheduleOverrides as never,
  };
}

function buildAfterReturnMessage(
  device: Device,
  depot: Depot,
  returnedAt: Date | null,
  exitedAt: Date,
  schedule: DepotSchedule,
): string {
  const entered = returnedAt
    ? formatInDepotZone(schedule, returnedAt)
    : 'inconnue';
  return (
    `${device.assetTag} a quitté le dépôt ${depot.name} après avoir été marqué ` +
    `comme retourné. Entrée : ${entered}. Sortie : ${formatInDepotZone(schedule, exitedAt)}.`
  );
}
