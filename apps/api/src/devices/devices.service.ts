import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertSeverity,
  AlertStatus,
  AlertType,
  Device,
  DeviceEnrollmentStatus,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { newId } from '../common/ids';
import { RealtimeService } from '../realtime/realtime.service';
import { AppPolicyReportDto, HeartbeatDto } from './dto/device.dto';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Heartbeat périodique. Volumétrie attendue : ~140 appels par appareil et par
   * jour, soit le point d'API le plus sollicité. Il reste donc délibérément
   * simple : une écriture, aucune jointure.
   */
  async heartbeat(deviceId: string, dto: HeartbeatDto): Promise<{ ok: true; serverTime: string }> {
    const now = new Date();

    const device = await this.prisma.raw.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: now,
        batteryLevel: dto.battery ?? undefined,
        isCharging: dto.charging ?? undefined,
        gpsEnabled: dto.gps ?? undefined,
        networkType: dto.network ?? undefined,
        appVersion: dto.appVersion ?? undefined,
        androidVersion: dto.androidVersion ?? undefined,
        storageFreeMb: dto.storageFreeMb ?? undefined,
        deviceOwnerActive: dto.deviceOwnerActive ?? undefined,
        // Le jeton FCM change au gré des réinstallations et des purges de Play
        // Services : on prend celui du dernier heartbeat, sans se demander s'il
        // a bougé.
        fcmToken: dto.fcmToken?.trim() || undefined,
      },
    });

    await this.checkHealthAlerts(device, dto);
    this.realtime.deviceUpdated(device);

    // Le téléphone se cale sur cette valeur pour dater ses événements et
    // détecter une manipulation de son horloge (docs/05 §4).
    return { ok: true, serverTime: now.toISOString() };
  }

  /**
   * Constat de politique d'applications rapporte par le telephone.
   *
   * On enregistre ce que l'appareil dit avoir fait, jamais ce qu'on lui a
   * demande. La nuance porte tout le sens de cette route : un telephone sans
   * Device Owner ne masque aucune application, et le tableau de bord doit le
   * montrer plutot que d'afficher un verrouillage imaginaire (§67).
   *
   * Un refus n'est pas une panne et ne leve pas d'alerte a lui seul. En
   * revanche, une politique demandee qu'un telephone dit ne PAS appliquer est
   * une divergence d'exploitation : elle se voit sur la fiche de l'appareil.
   */
  async reportAppPolicy(
    deviceId: string,
    dto: AppPolicyReportDto,
  ): Promise<{ ok: true }> {
    const report = {
      enforced: dto.enforced,
      configVersion: dto.configVersion,
      hidden: dto.hidden,
      refusals: dto.refusals.map((r) => ({
        packageName: r.packageName,
        reason: r.reason,
      })),
    };

    const device = await this.prisma.raw.device.update({
      where: { id: deviceId },
      data: { appPolicyReport: report, appPolicyAppliedAt: new Date() },
    });

    if (!dto.enforced) {
      this.logger.warn(
        `Appareil ${device.assetTag} : politique d'applications non appliquee ` +
          "(Device Owner absent). Aucune application n'est masquee.",
      );
    }

    this.realtime.deviceUpdated(device);
    return { ok: true };
  }

  private async checkHealthAlerts(device: Device, dto: HeartbeatDto): Promise<void> {
    const settings = await this.settings.resolveForDevice(
      device.companyId,
      device.id,
      device.depotId,
    );

    if (
      typeof dto.battery === 'number' &&
      dto.battery <= settings.batteryAlertThreshold &&
      dto.charging !== true
    ) {
      await this.alerts.raise({
        companyId: device.companyId,
        deviceId: device.id,
        depotId: device.depotId,
        type: AlertType.BATTERY_LOW,
        severity: AlertSeverity.MEDIUM,
        title: 'Batterie faible',
        message: `${device.assetTag} : batterie à ${dto.battery} % (seuil ${settings.batteryAlertThreshold} %).`,
        // Une alerte par appareil tant qu'elle n'est pas acquittée.
        dedupeKey: `battery-low:${device.id}`,
        context: { battery: dto.battery, threshold: settings.batteryAlertThreshold },
      });
    }

    if (dto.gps === false) {
      await this.alerts.raise({
        companyId: device.companyId,
        deviceId: device.id,
        depotId: device.depotId,
        type: AlertType.LOCATION_DISABLED,
        severity: AlertSeverity.HIGH,
        title: 'Localisation désactivée',
        message: `${device.assetTag} signale une localisation désactivée alors qu'elle est imposée par la politique de l'appareil.`,
        dedupeKey: `location-disabled:${device.id}`,
      });
      await this.prisma.raw.securityEvent.create({
        data: {
          id: newId(),
          companyId: device.companyId,
          deviceId: device.id,
          type: SecurityEventType.LOCATION_DISABLED,
          severity: SecuritySeverity.HIGH,
          occurredAt: new Date(),
          metadata: {} as Prisma.InputJsonValue,
        },
      });
    }

    // Le retour à la normale referme automatiquement les alertes de santé :
    // sans cela, le dashboard accumulerait des alertes obsolètes que plus
    // personne ne regarde.
    if (dto.gps === true) {
      await this.autoClose(device.companyId, `location-disabled:${device.id}`);
    }
    if (typeof dto.battery === 'number' && dto.battery > settings.batteryAlertThreshold) {
      await this.autoClose(device.companyId, `battery-low:${device.id}`);
    }
  }

  private async autoClose(companyId: string, dedupeKey: string): Promise<void> {
    await this.prisma.raw.alert.updateMany({
      where: { companyId, dedupeKey, status: AlertStatus.OPEN },
      data: { status: AlertStatus.AUTO_CLOSED, resolvedAt: new Date() },
    });
  }

  async findAll(params: {
    depotId?: string;
    state?: string;
    take: number;
    skip: number;
  }) {
    const where: Prisma.DeviceWhereInput = {
      deletedAt: null,
      ...(params.depotId ? { depotId: params.depotId } : {}),
      ...(params.state ? { state: params.state as never } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.db.device.findMany({
        where,
        take: params.take,
        skip: params.skip,
        orderBy: { assetTag: 'asc' },
        include: {
          depot: { select: { id: true, name: true } },
          sessions: {
            where: { status: 'ACTIVE' },
            take: 1,
            select: {
              id: true,
              startedAt: true,
              state: true,
              user: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.db.device.count({ where }),
    ]);

    return { items: items.map(toDeviceView), total, take: params.take, skip: params.skip };
  }

  async findOne(id: string) {
    const device = await this.prisma.db.device.findFirst({
      where: { id, deletedAt: null },
      include: {
        depot: true,
        sessions: {
          orderBy: { startedAt: 'desc' },
          take: 5,
          include: { user: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!device) throw new NotFoundException('Appareil introuvable.');

    const settings = await this.settings.resolveForDevice(
      device.companyId,
      device.id,
      device.depotId,
    );

    return {
      ...toDeviceView(device),
      settings,
      // Deux champs volontairement cote a cote : la politique DEMANDEE
      // (dans `settings`) et ce que l'appareil dit en avoir applique. Les
      // afficher ensemble est la seule facon de rendre un ecart visible.
      appPolicy: device.appPolicyReport
        ? {
            ...(device.appPolicyReport as Record<string, unknown>),
            appliedAt: device.appPolicyAppliedAt,
          }
        : null,
    };
  }

  async create(companyId: string, assetTag: string, depotId?: string, kioskMode?: never) {
    // Même précaution que pour les chauffeurs : la clé étrangère ne vérifie
    // pas l'appartenance du dépôt à l'entreprise active.
    if (depotId) {
      const depot = await this.prisma.db.depot.findFirst({
        where: { id: depotId, deletedAt: null },
      });
      if (!depot) throw new NotFoundException('Dépôt introuvable.');
    }

    return this.prisma.db.device.create({
      data: {
        id: newId(),
        companyId,
        assetTag,
        depotId: depotId ?? null,
        kioskMode: kioskMode ?? undefined,
        enrollmentStatus: DeviceEnrollmentStatus.PENDING,
      },
    });
  }
}

type DeviceWithRelations = Device & {
  depot?: { id: string; name: string } | null;
  sessions?: Array<{
    id: string;
    startedAt: Date;
    state: string;
    user: { id: string; firstName: string; lastName: string };
  }>;
};

function toDeviceView(device: DeviceWithRelations) {
  const session = device.sessions?.[0];
  return {
    id: device.id,
    assetTag: device.assetTag,
    manufacturer: device.manufacturer,
    model: device.model,
    androidVersion: device.androidVersion,
    appVersion: device.appVersion,
    state: device.state,
    enrollmentStatus: device.enrollmentStatus,
    kioskMode: device.kioskMode,
    // Jamais présenté comme acquis : tant que l'appareil ne l'a pas confirmé,
    // le kiosque n'est pas garanti (docs/04 §6).
    deviceOwnerActive: device.deviceOwnerActive,
    depot: device.depot ?? null,
    battery: device.batteryLevel,
    charging: device.isCharging,
    gpsEnabled: device.gpsEnabled,
    networkType: device.networkType,
    storageFreeMb: device.storageFreeMb,
    lastSeenAt: device.lastSeenAt,
    lastSyncAt: device.lastSyncAt,
    lastLocation:
      device.lastLatitude != null && device.lastLongitude != null
        ? {
            latitude: device.lastLatitude,
            longitude: device.lastLongitude,
            accuracy: device.lastAccuracy,
            at: device.lastLocationAt,
          }
        : null,
    currentSession: session
      ? {
          id: session.id,
          startedAt: session.startedAt,
          state: session.state,
          user: session.user,
        }
      : null,
  };
}
