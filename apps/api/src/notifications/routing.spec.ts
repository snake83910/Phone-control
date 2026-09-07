import { AlertSeverity, AlertType } from '@prisma/client';
import {
  DEFAULT_MAX_PER_HOUR,
  isQuietHour,
  notificationConfigSchema,
  routeAlert,
  type NotificationConfig,
} from './routing';

/**
 * Acheminement des alertes.
 *
 * Ce module décide surtout **quand se taire**. Une console d'exploitation qui
 * reçoit cinquante notifications pendant un incident réseau cesse d'être lue,
 * et la première vraie alerte du lendemain passe inaperçue.
 *
 * La seule exception, vérifiée sous tous les angles ici : une alerte `CRITICAL`
 * part toujours.
 */
describe('Acheminement des notifications', () => {
  const config = (overrides: Partial<NotificationConfig> = {}): NotificationConfig =>
    notificationConfigSchema.parse({
      webhooks: [{ url: 'https://hooks.exemple.fr/exploitation', label: 'Exploitation' }],
      ...overrides,
    });

  const route = (
    severity: AlertSeverity,
    options: {
      config?: NotificationConfig | null;
      now?: Date;
      sentInLastHour?: number;
      type?: AlertType;
    } = {},
  ) =>
    routeAlert({
      alert: { type: options.type ?? AlertType.AFTER_RETURN_EXIT, severity },
      config: options.config === undefined ? config() : options.config,
      now: options.now ?? new Date('2026-09-05T14:00:00Z'),
      sentInLastHour: options.sentInLastHour ?? 0,
    });

  describe('seuils', () => {
    it('retient ce qui est en dessous du seuil du canal', () => {
      const decision = route(AlertSeverity.MEDIUM);

      expect(decision.targets).toHaveLength(0);
      expect(decision.suppressed[0].reason).toBe('BELOW_THRESHOLD');
    });

    it('laisse passer à partir du seuil, HIGH par défaut', () => {
      expect(route(AlertSeverity.HIGH).targets).toHaveLength(1);
      expect(route(AlertSeverity.CRITICAL).targets).toHaveLength(1);
    });

    it('respecte un seuil abaissé par le client', () => {
      const permissive = config({
        webhooks: [{ url: 'https://hooks.exemple.fr/tout', minSeverity: AlertSeverity.LOW }],
      });

      expect(route(AlertSeverity.LOW, { config: permissive }).targets).toHaveLength(1);
    });
  });

  describe('filtrage par type', () => {
    it('ne retient que les types demandés', () => {
      const filtered = config({
        webhooks: [
          {
            url: 'https://hooks.exemple.fr/depot',
            types: [AlertType.AFTER_RETURN_EXIT],
          },
        ],
      });

      expect(route(AlertSeverity.HIGH, { config: filtered }).targets).toHaveLength(1);

      const other = route(AlertSeverity.HIGH, {
        config: filtered,
        type: AlertType.DEVICE_TAMPERING,
      });
      expect(other.targets).toHaveLength(0);
      expect(other.suppressed[0].reason).toBe('TYPE_NOT_SELECTED');
    });

    it('une liste de types absente signifie « tous »', () => {
      expect(
        route(AlertSeverity.HIGH, { type: AlertType.DEVICE_TAMPERING }).targets,
      ).toHaveLength(1);
    });
  });

  describe('heures creuses', () => {
    const quiet = config({
      quietHours: { start: '22:00', end: '06:00', timezone: 'Europe/Paris' },
    });

    // 23 h à Paris en septembre = 21 h UTC.
    const nuit = new Date('2026-09-05T21:00:00Z');
    const jour = new Date('2026-09-05T10:00:00Z');

    it('retient une alerte HIGH la nuit', () => {
      const decision = route(AlertSeverity.HIGH, { config: quiet, now: nuit });

      expect(decision.targets).toHaveLength(0);
      expect(decision.suppressed[0].reason).toBe('QUIET_HOURS');
    });

    it('laisse passer une alerte CRITICAL la nuit', () => {
      // Personne ne voudra apprendre qu'une sortie de dépôt à deux heures du
      // matin n'a pas été signalée parce qu'il était tard.
      expect(route(AlertSeverity.CRITICAL, { config: quiet, now: nuit }).targets).toHaveLength(1);
    });

    it('ne retient rien en journée', () => {
      expect(route(AlertSeverity.HIGH, { config: quiet, now: jour }).targets).toHaveLength(1);
    });

    it('raisonne dans le fuseau de l’entreprise, pas celui du serveur', () => {
      const zone = { start: '22:00', end: '06:00', timezone: 'Europe/Paris' };

      // 21:00 UTC = 23:00 à Paris : nuit.
      expect(isQuietHour(zone, new Date('2026-09-05T21:00:00Z'))).toBe(true);
      // 05:00 UTC = 07:00 à Paris : jour, alors que l'heure UTC est encore creuse.
      expect(isQuietHour(zone, new Date('2026-09-05T05:00:00Z'))).toBe(false);
    });

    it('gère une plage qui ne traverse pas minuit', () => {
      const midi = { start: '12:00', end: '14:00', timezone: 'UTC' };

      expect(isQuietHour(midi, new Date('2026-09-05T13:00:00Z'))).toBe(true);
      expect(isQuietHour(midi, new Date('2026-09-05T15:00:00Z'))).toBe(false);
      expect(isQuietHour(midi, new Date('2026-09-05T23:00:00Z'))).toBe(false);
    });

    it('ignore un fuseau invalide plutôt que de tout retenir', () => {
      // Une faute de frappe dans la configuration ne doit pas faire taire les
      // alertes : le silence est le pire des échecs pour ce module.
      expect(
        isQuietHour(
          { start: '22:00', end: '06:00', timezone: 'Europe/Pariss' },
          new Date('2026-09-05T21:00:00Z'),
        ),
      ).toBe(false);
    });
  });

  describe('limite de débit', () => {
    it('retient au-delà du plafond', () => {
      const decision = route(AlertSeverity.HIGH, { sentInLastHour: DEFAULT_MAX_PER_HOUR });

      expect(decision.targets).toHaveLength(0);
      expect(decision.suppressed[0].reason).toBe('RATE_LIMITED');
    });

    it('laisse passer une alerte CRITICAL malgré le plafond', () => {
      expect(
        route(AlertSeverity.CRITICAL, { sentInLastHour: 10_000 }).targets,
      ).toHaveLength(1);
    });

    it('respecte un plafond fixé par le client', () => {
      const strict = config({ maxPerHour: 2 });

      expect(route(AlertSeverity.HIGH, { config: strict, sentInLastHour: 1 }).targets).toHaveLength(1);
      expect(route(AlertSeverity.HIGH, { config: strict, sentInLastHour: 2 }).targets).toHaveLength(0);
    });
  });

  describe('absence de configuration', () => {
    it('ne notifie rien et le dit', () => {
      const decision = route(AlertSeverity.CRITICAL, { config: null });

      expect(decision.targets).toHaveLength(0);
      expect(decision.suppressed[0].reason).toBe('NOT_CONFIGURED');
    });

    it('traite une configuration vide comme une absence', () => {
      const decision = route(AlertSeverity.CRITICAL, {
        config: notificationConfigSchema.parse({}),
      });

      expect(decision.suppressed[0].reason).toBe('NOT_CONFIGURED');
    });
  });

  describe('plusieurs canaux', () => {
    it('alimente chaque canal selon ses propres règles', () => {
      const mixed = notificationConfigSchema.parse({
        webhooks: [
          { url: 'https://hooks.exemple.fr/tout', minSeverity: 'MEDIUM', label: 'Tout' },
          { url: 'https://hooks.exemple.fr/graves', minSeverity: 'CRITICAL', label: 'Graves' },
        ],
        email: { recipients: ['exploitation@exemple.fr'], minSeverity: 'HIGH' },
      });

      const medium = route(AlertSeverity.MEDIUM, { config: mixed });
      expect(medium.targets.map((t) => t.label)).toEqual(['Tout']);

      const high = route(AlertSeverity.HIGH, { config: mixed });
      expect(high.targets.map((t) => t.channel)).toEqual(['webhook', 'email']);

      const critical = route(AlertSeverity.CRITICAL, { config: mixed });
      expect(critical.targets).toHaveLength(3);
    });
  });

  describe('schéma de configuration', () => {
    it('refuse une clé inconnue plutôt que de l’ignorer', () => {
      expect(() =>
        notificationConfigSchema.parse({ webhoks: [{ url: 'https://x.fr' }] }),
      ).toThrow();
    });

    it('refuse une URL ou une adresse invalide', () => {
      expect(() => notificationConfigSchema.parse({ webhooks: [{ url: 'pas-une-url' }] })).toThrow();
      expect(() =>
        notificationConfigSchema.parse({ email: { recipients: ['pas-une-adresse'] } }),
      ).toThrow();
    });

    it('refuse une heure mal formée', () => {
      expect(() =>
        notificationConfigSchema.parse({
          quietHours: { start: '25:00', end: '06:00', timezone: 'Europe/Paris' },
        }),
      ).toThrow();
    });
  });
});
