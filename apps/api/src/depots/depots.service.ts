import { Injectable, NotFoundException } from '@nestjs/common';
import { Depot, GeofenceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newId } from '../common/ids';
import {
  DepotSchedule,
  nextLockInstant,
  parseTime,
  resolveDayRules,
  operationalDayOf,
  returnInstantFor,
  ScheduleConfigError,
} from '../rules/schedule';
import { CreateDepotDto, UpdateDepotDto } from './dto/depot.dto';

@Injectable()
export class DepotsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * La création d'un dépôt crée aussi son geofence : le premier est une entité
   * d'organisation, le second une zone que le téléphone surveille. Les
   * dissocier serait source d'incohérence, un dépôt sans geofence ne
   * déclenchant jamais rien.
   */
  async create(companyId: string, dto: CreateDepotDto) {
    this.validateSchedule(dto);

    return this.prisma.raw.$transaction(async (tx) => {
      const depot = await tx.depot.create({
        data: {
          id: newId(),
          companyId,
          code: dto.code,
          name: dto.name,
          latitude: dto.latitude,
          longitude: dto.longitude,
          radiusMeters: dto.radiusMeters ?? 250,
          exitHysteresisMeters: dto.exitHysteresisMeters ?? 75,
          timezone: dto.timezone ?? 'Europe/Paris',
          returnTime: dto.returnTime ?? '18:00',
          lockTime: dto.lockTime ?? '22:00',
          operationalDayStart: dto.operationalDayStart ?? '04:00',
          scheduleOverrides: (dto.scheduleOverrides ?? {}) as never,
          wifiHints: (dto.wifiHints ?? []) as never,
        },
      });

      await tx.geofence.create({
        data: {
          id: newId(),
          companyId,
          depotId: depot.id,
          name: depot.name,
          type: GeofenceType.DEPOT,
          latitude: depot.latitude,
          longitude: depot.longitude,
          radiusMeters: depot.radiusMeters,
          hysteresisMeters: depot.exitHysteresisMeters,
        },
      });

      return depot;
    });
  }

  async findAll() {
    return this.prisma.db.depot.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { devices: true, users: true } } },
    });
  }

  async findOne(id: string) {
    const depot = await this.prisma.db.depot.findFirst({
      where: { id, deletedAt: null },
      include: { geofences: true },
    });
    if (!depot) throw new NotFoundException('Dépôt introuvable.');

    // Les règles du jour sont calculées et renvoyées : le dashboard n'a pas à
    // réimplémenter la résolution des surcharges ni les fuseaux horaires.
    const schedule = toSchedule(depot);
    const now = new Date();
    const today = operationalDayOf(schedule, now);

    return {
      ...depot,
      today: {
        operationalDay: today,
        rules: resolveDayRules(schedule, today),
        returnInstant: returnInstantFor(schedule, now),
        nextLockInstant: nextLockInstant(schedule, now),
      },
    };
  }

  async update(id: string, dto: UpdateDepotDto) {
    this.validateSchedule(dto);

    return this.prisma.raw.$transaction(async (tx) => {
      const depot = await tx.depot.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
          ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
          ...(dto.radiusMeters !== undefined ? { radiusMeters: dto.radiusMeters } : {}),
          ...(dto.exitHysteresisMeters !== undefined
            ? { exitHysteresisMeters: dto.exitHysteresisMeters }
            : {}),
          ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
          ...(dto.returnTime !== undefined ? { returnTime: dto.returnTime } : {}),
          ...(dto.lockTime !== undefined ? { lockTime: dto.lockTime } : {}),
          ...(dto.operationalDayStart !== undefined
            ? { operationalDayStart: dto.operationalDayStart }
            : {}),
          ...(dto.scheduleOverrides !== undefined
            ? { scheduleOverrides: dto.scheduleOverrides as never }
            : {}),
          ...(dto.wifiHints !== undefined ? { wifiHints: dto.wifiHints as never } : {}),
        },
      });

      // Le geofence suit la géométrie du dépôt : sans cette propagation, une
      // correction de coordonnées resterait sans effet sur le terrain.
      if (
        dto.latitude !== undefined ||
        dto.longitude !== undefined ||
        dto.radiusMeters !== undefined ||
        dto.exitHysteresisMeters !== undefined
      ) {
        await tx.geofence.updateMany({
          where: { depotId: id, type: GeofenceType.DEPOT },
          data: {
            latitude: depot.latitude,
            longitude: depot.longitude,
            radiusMeters: depot.radiusMeters,
            hysteresisMeters: depot.exitHysteresisMeters,
          },
        });
      }

      return depot;
    });
  }

  private validateSchedule(dto: Partial<CreateDepotDto>): void {
    if (dto.returnTime) parseTime(dto.returnTime, 'returnTime');
    if (dto.lockTime) parseTime(dto.lockTime, 'lockTime');
    if (dto.operationalDayStart)
      parseTime(dto.operationalDayStart, 'operationalDayStart');

    if (dto.timezone) {
      // Un fuseau invalide rendrait toutes les règles horaires du dépôt
      // silencieusement fausses : refus à l'écriture, pas à l'exécution.
      const probe: DepotSchedule = {
        timezone: dto.timezone,
        returnTime: dto.returnTime ?? '18:00',
        lockTime: dto.lockTime ?? '22:00',
        operationalDayStart: dto.operationalDayStart ?? '04:00',
      };
      try {
        operationalDayOf(probe, new Date());
      } catch (err) {
        if (err instanceof ScheduleConfigError) throw err;
        throw err;
      }
    }
  }
}

export function toSchedule(depot: Depot): DepotSchedule {
  return {
    timezone: depot.timezone,
    returnTime: depot.returnTime,
    lockTime: depot.lockTime,
    operationalDayStart: depot.operationalDayStart,
    overrides: depot.scheduleOverrides as never,
  };
}
