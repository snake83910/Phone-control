import { AlertSeverity, AlertType } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';

/**
 * Acheminement des alertes vers les humains.
 *
 * Module **pur** : aucune entrée-sortie, aucune dépendance à Nest. Ce qui est
 * décidé ici — qui est prévenu, quand, et surtout quand on s'abstient — se teste
 * sans serveur de courrier ni webhook.
 *
 * Une règle domine toutes les autres : **une alerte CRITICAL passe toujours.**
 * Ni les heures creuses, ni la limite de débit ne s'y appliquent. Le jour où un
 * téléphone signale une sortie de dépôt après le retour à deux heures du matin,
 * personne ne voudra apprendre que la notification a été retenue parce qu'il
 * était tard.
 */

export const severityRank: Record<AlertSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:MM.');

const channelFilters = z.object({
  /** Sévérité minimale pour ce canal. Par défaut : HIGH. */
  minSeverity: z.nativeEnum(AlertSeverity).optional(),
  /** Types retenus. Absent ou vide : tous les types. */
  types: z.array(z.nativeEnum(AlertType)).optional(),
});

export const notificationConfigSchema = z
  .object({
    webhooks: z
      .array(
        channelFilters.extend({
          url: z.string().url(),
          /** Nom lisible, pour les journaux : « Slack exploitation ». */
          label: z.string().max(64).optional(),
        }),
      )
      .max(10)
      .optional(),

    email: channelFilters
      .extend({
        recipients: z.array(z.string().email()).min(1).max(20),
      })
      .optional(),

    /**
     * Heures creuses. Les alertes non critiques y sont retenues.
     * Le fuseau est celui de l'entreprise, pas celui du serveur : une flotte
     * française ne se réveille pas à l'heure UTC.
     */
    quietHours: z
      .object({
        start: timeOfDay,
        end: timeOfDay,
        timezone: z.string().min(1),
      })
      .optional(),

    /**
     * Plafond horaire, toutes alertes non critiques confondues.
     * Un incident réseau peut produire cinquante alertes en dix minutes ; au-delà
     * du plafond, plus personne ne les lit, et les suivantes noient les vraies.
     */
    maxPerHour: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;

export const DEFAULT_MIN_SEVERITY: AlertSeverity = AlertSeverity.HIGH;
export const DEFAULT_MAX_PER_HOUR = 20;

export interface RoutableAlert {
  type: AlertType;
  severity: AlertSeverity;
}

export type SuppressionReason =
  | 'BELOW_THRESHOLD'
  | 'TYPE_NOT_SELECTED'
  | 'QUIET_HOURS'
  | 'RATE_LIMITED'
  | 'NOT_CONFIGURED';

export interface NotificationTarget {
  channel: 'webhook' | 'email';
  /** URL du webhook, ou liste de destinataires pour le courrier. */
  destination: string;
  label: string;
}

export interface RoutingDecision {
  targets: NotificationTarget[];
  /** Ce qui n'a pas été envoyé, et pourquoi. Sert aux journaux et aux tests. */
  suppressed: Array<{ label: string; reason: SuppressionReason }>;
}

/** Vrai si l'instant tombe dans la plage d'heures creuses. */
export function isQuietHour(
  quietHours: NonNullable<NotificationConfig['quietHours']>,
  at: Date,
): boolean {
  const local = DateTime.fromJSDate(at, { zone: quietHours.timezone });
  if (!local.isValid) return false;

  const minutes = local.hour * 60 + local.minute;
  const toMinutes = (value: string): number => {
    const [hours, mins] = value.split(':').map(Number);
    return hours * 60 + mins;
  };

  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);

  // La plage traverse minuit dans le cas usuel — 22:00 à 06:00 — et il serait
  // facile de ne traiter que le cas simple, où elle ne le traverse pas.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Décide où part une alerte.
 *
 * `sentInLastHour` est fourni par l'appelant : compter les envois relève de la
 * base, pas de la décision.
 */
export function routeAlert(params: {
  alert: RoutableAlert;
  config: NotificationConfig | null;
  now: Date;
  sentInLastHour: number;
}): RoutingDecision {
  const { alert, config, now, sentInLastHour } = params;
  const targets: NotificationTarget[] = [];
  const suppressed: RoutingDecision['suppressed'] = [];

  if (!config || (!config.webhooks?.length && !config.email)) {
    return { targets, suppressed: [{ label: 'aucun canal', reason: 'NOT_CONFIGURED' }] };
  }

  const critical = alert.severity === AlertSeverity.CRITICAL;

  // Les deux garde-fous ci-dessous ne s'appliquent jamais à une alerte
  // critique. C'est la seule exception du module, et elle est délibérée.
  if (!critical && config.quietHours && isQuietHour(config.quietHours, now)) {
    return { targets, suppressed: [{ label: 'tous les canaux', reason: 'QUIET_HOURS' }] };
  }

  const ceiling = config.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
  if (!critical && sentInLastHour >= ceiling) {
    return { targets, suppressed: [{ label: 'tous les canaux', reason: 'RATE_LIMITED' }] };
  }

  const accepts = (
    filters: z.infer<typeof channelFilters>,
    label: string,
  ): SuppressionReason | null => {
    const minimum = filters.minSeverity ?? DEFAULT_MIN_SEVERITY;
    if (severityRank[alert.severity] < severityRank[minimum]) return 'BELOW_THRESHOLD';
    if (filters.types?.length && !filters.types.includes(alert.type)) {
      return 'TYPE_NOT_SELECTED';
    }
    void label;
    return null;
  };

  for (const [index, webhook] of (config.webhooks ?? []).entries()) {
    const label = webhook.label ?? `webhook ${index + 1}`;
    const refusal = accepts(webhook, label);
    if (refusal) {
      suppressed.push({ label, reason: refusal });
      continue;
    }
    targets.push({ channel: 'webhook', destination: webhook.url, label });
  }

  if (config.email) {
    const label = `courriel (${config.email.recipients.length} destinataire(s))`;
    const refusal = accepts(config.email, label);
    if (refusal) {
      suppressed.push({ label, reason: refusal });
    } else {
      targets.push({
        channel: 'email',
        destination: config.email.recipients.join(','),
        label,
      });
    }
  }

  return { targets, suppressed };
}
