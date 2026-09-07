import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Résolution en cascade de la configuration : entreprise -> dépôt -> appareil.
 *
 * Aucune valeur (18:00, 22:00, 250 m, 8 h) n'est écrite en dur dans le code
 * applicatif : les défauts vivent ici et en base, et sont surchargeables à
 * chacun des trois niveaux (exigence §61 de la spécification).
 */

export interface ResolvedSettings {
  locationIntervalActiveSeconds: number;
  locationIntervalIdleSeconds: number;
  locationMinDistanceMeters: number;
  heartbeatIntervalSeconds: number;
  syncIntervalSeconds: number;
  offlineAuthEnabled: boolean;
  offlineAuthMaxDurationMinutes: number;
  offlineCacheMaxAgeMinutes: number;
  sessionMaxDurationMinutes: number;
  batteryAlertThreshold: number;
  offlineAlertDelayMinutes: number;
  gpsAccuracyThresholdMeters: number;
  geofenceConfirmationSeconds: number;
  geofenceConfirmationSamples: number;
  /** Paquets pouvant s'ouvrir a cote de l'application pendant une session. */
  allowedApps: string[];
  /** Paquets masques sur le telephone, session ouverte ou non. */
  blockedApps: string[];
  kioskFeatures: Record<string, unknown>;
  /** Somme des versions des niveaux appliqués : change dès qu'un niveau change. */
  version: number;
}

export const DEFAULT_SETTINGS: ResolvedSettings = {
  locationIntervalActiveSeconds: 60,
  locationIntervalIdleSeconds: 300,
  locationMinDistanceMeters: 50,
  heartbeatIntervalSeconds: 300,
  syncIntervalSeconds: 900,
  offlineAuthEnabled: true,
  offlineAuthMaxDurationMinutes: 480,
  offlineCacheMaxAgeMinutes: 1440,
  sessionMaxDurationMinutes: 960,
  batteryAlertThreshold: 15,
  offlineAlertDelayMinutes: 30,
  gpsAccuracyThresholdMeters: 100,
  geofenceConfirmationSeconds: 120,
  geofenceConfirmationSamples: 3,
  allowedApps: [],
  blockedApps: [],
  kioskFeatures: {},
  version: 0,
};

const NUMERIC_KEYS = [
  'locationIntervalActiveSeconds',
  'locationIntervalIdleSeconds',
  'locationMinDistanceMeters',
  'heartbeatIntervalSeconds',
  'syncIntervalSeconds',
  'offlineAuthMaxDurationMinutes',
  'offlineCacheMaxAgeMinutes',
  'sessionMaxDurationMinutes',
  'batteryAlertThreshold',
  'offlineAlertDelayMinutes',
  'gpsAccuracyThresholdMeters',
  'geofenceConfirmationSeconds',
  'geofenceConfirmationSamples',
] as const;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveForDevice(
    companyId: string,
    deviceId: string,
    depotId: string | null,
  ): Promise<ResolvedSettings> {
    return this.resolve(companyId, deviceId, depotId);
  }

  /**
   * Réglages d'une entreprise, sans appareil.
   *
   * Cette méthode existe parce que l'appeler avec un identifiant d'appareil
   * vide produisait un UUID invalide et faisait échouer la requête — défaut
   * silencieux, puisque l'erreur était avalée par la boucle de la tâche de
   * surveillance. Les seuils d'entreprise ont un usage propre : ils servent au
   * tableau de bord, à la carte et aux tâches planifiées.
   */
  async resolveForCompany(
    companyId: string,
    depotId: string | null = null,
  ): Promise<ResolvedSettings> {
    return this.resolve(companyId, null, depotId);
  }

  private async resolve(
    companyId: string,
    deviceId: string | null,
    depotId: string | null,
  ): Promise<ResolvedSettings> {
    const rows = await this.prisma.raw.deviceSettings.findMany({
      where: {
        companyId,
        OR: [
          ...(deviceId ? [{ deviceId }] : []),
          ...(depotId ? [{ depotId, deviceId: null }] : []),
          { deviceId: null, depotId: null },
        ],
      },
    });

    // Ordre d'application : entreprise, puis dépôt, puis appareil.
    const rank = (r: (typeof rows)[number]): number =>
      r.deviceId ? 3 : r.depotId ? 2 : 1;
    const ordered = [...rows].sort((a, b) => rank(a) - rank(b));

    let resolved: ResolvedSettings = { ...DEFAULT_SETTINGS };
    let version = 0;

    for (const row of ordered) {
      version += row.version;
      for (const key of NUMERIC_KEYS) {
        const value = row[key];
        if (typeof value === 'number') {
          (resolved as unknown as Record<string, unknown>)[key] = value;
        }
      }
      resolved.offlineAuthEnabled = row.offlineAuthEnabled;
      if (Array.isArray(row.allowedApps)) {
        resolved.allowedApps = row.allowedApps as string[];
      }
      if (Array.isArray(row.blockedApps)) {
        resolved.blockedApps = row.blockedApps as string[];
      }
      if (row.kioskFeatures && typeof row.kioskFeatures === 'object') {
        resolved.kioskFeatures = row.kioskFeatures as Record<string, unknown>;
      }
    }

    resolved = { ...resolved, version };
    return resolved;
  }
}
