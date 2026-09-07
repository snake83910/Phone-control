import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AlertSeverity, AlertType, Prisma } from '@prisma/client';
import { createTransport } from 'nodemailer';
import {
  CompanyFixture,
  TestContext,
  createTestApp,
  seedCompany,
  seedDevice,
  uniqueSuffix,
} from './fixtures';
import { AlertsService } from '../src/alerts/alerts.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { EmailChannel, WebhookChannel } from '../src/notifications/channels';
import { SettingsService } from '../src/settings/settings.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Notification des alertes, de bout en bout.
 *
 * Le webhook part vers un **vrai serveur HTTP** monté dans le test : c'est la
 * seule façon de savoir que la charge utile est bien formée et que le canal
 * atteint sa destination. Le courriel passe par le transport `jsonTransport` de
 * nodemailer, qui compose le message sans l'envoyer — tout est vérifié sauf la
 * conversation SMTP elle-même, qui demanderait un relais.
 */
describe('Notification des alertes', () => {
  let ctx: TestContext;
  let company: CompanyFixture;
  let alerts: AlertsService;
  let notifications: NotificationsService;

  let webhookServer: Server;
  let webhookUrl: string;
  let received: Array<Record<string, unknown>> = [];
  let respondWith = 200;

  beforeAll(async () => {
    ctx = await createTestApp();
    company = await seedCompany(ctx);
    alerts = ctx.app.get(AlertsService);
    notifications = ctx.app.get(NotificationsService);

    webhookServer = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received.push(JSON.parse(body || '{}'));
        response.statusCode = respondWith;
        response.end('{}');
      });
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
    const port = (webhookServer.address() as AddressInfo).port;
    webhookUrl = `http://127.0.0.1:${port}/alerts`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    await ctx.app.close();
  });

  beforeEach(() => {
    received = [];
    respondWith = 200;
  });

  async function configure(notificationsConfig: unknown): Promise<void> {
    await TenantContext.system(() =>
      ctx.prisma.raw.company.update({
        where: { id: company.company.id },
        data: {
          settings: { notifications: notificationsConfig } as Prisma.InputJsonValue,
        },
      }),
    );
  }

  async function raise(
    severity: AlertSeverity,
    type: AlertType = AlertType.AFTER_RETURN_EXIT,
  ) {
    return TenantContext.system(() =>
      alerts.raise({
        companyId: company.company.id,
        type,
        severity,
        title: 'Sortie du dépôt après le retour',
        message: 'TEL-001 a quitté le dépôt à 23 h 12.',
        dedupeKey: `test:${uniqueSuffix()}`,
      }),
    );
  }

  /** Laisse le temps au `void dispatch(...)` de s'exécuter. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  it('envoie une alerte HIGH vers le webhook configuré', async () => {
    await configure({ webhooks: [{ url: webhookUrl, label: 'Exploitation' }] });

    await raise(AlertSeverity.HIGH);
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      severity: 'HIGH',
      type: AlertType.AFTER_RETURN_EXIT,
      title: 'Sortie du dépôt après le retour',
      company: company.company.name,
    });
    expect(received[0].text).toContain('[HIGH]');
  });

  it('marque l’alerte comme notifiée', async () => {
    await configure({ webhooks: [{ url: webhookUrl }] });

    const alert = await raise(AlertSeverity.HIGH);
    await settle();

    const stored = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findUnique({ where: { id: alert.id } }),
    );
    expect(stored?.notifiedAt).not.toBeNull();
  });

  it('n’envoie rien en dessous du seuil', async () => {
    await configure({ webhooks: [{ url: webhookUrl }] });

    await raise(AlertSeverity.MEDIUM);
    await settle();

    expect(received).toHaveLength(0);
  });

  it('n’envoie rien quand l’entreprise n’a rien configuré', async () => {
    await configure(undefined);

    await raise(AlertSeverity.CRITICAL);
    await settle();

    expect(received).toHaveLength(0);
  });

  it('ignore une configuration invalide sans faire échouer l’alerte', async () => {
    // Le point important : l'alerte est bien créée. Une faute de frappe dans la
    // configuration ne doit pas faire disparaître l'événement lui-même.
    await configure({ webhoks: [{ url: webhookUrl }] });

    const alert = await raise(AlertSeverity.CRITICAL);
    await settle();

    expect(alert.id).toBeDefined();
    expect(received).toHaveLength(0);
  });

  it('crée l’alerte même si le webhook répond en erreur', async () => {
    await configure({ webhooks: [{ url: webhookUrl }] });
    respondWith = 500;

    const alert = await raise(AlertSeverity.HIGH);
    await settle();

    expect(received).toHaveLength(1);

    const stored = await TenantContext.system(() =>
      ctx.prisma.raw.alert.findUnique({ where: { id: alert.id } }),
    );
    // L'alerte existe, mais elle n'est PAS marquée notifiée : personne ne l'a reçue.
    expect(stored).not.toBeNull();
    expect(stored?.notifiedAt).toBeNull();
  });

  it('crée l’alerte même si le webhook est injoignable', async () => {
    await configure({ webhooks: [{ url: 'http://127.0.0.1:1/injoignable' }] });

    const alert = await raise(AlertSeverity.HIGH);
    await settle();

    expect(alert.id).toBeDefined();
  });

  it('sert plusieurs canaux pour une même alerte', async () => {
    await configure({
      webhooks: [
        { url: webhookUrl, label: 'A' },
        { url: webhookUrl, label: 'B' },
      ],
    });

    await raise(AlertSeverity.CRITICAL);
    await settle();

    expect(received).toHaveLength(2);
  });

  describe('canal courriel', () => {
    it('compose un message lisible et adressé aux bons destinataires', async () => {
      // `jsonTransport` compose le message sans l'envoyer : tout est vérifiable
      // sauf la conversation SMTP, qui demanderait un relais.
      const transporter = createTransport({ jsonTransport: true });
      const channel = new EmailChannel(undefined, 'alertes@exemple.fr', transporter);

      expect(channel.configured).toBe(true);

      const result = await channel.send('a@exemple.fr,b@exemple.fr', {
        alertId: 'x',
        type: AlertType.AFTER_RETURN_EXIT,
        severity: 'CRITICAL',
        title: 'Sortie du dépôt après le retour',
        body: 'TEL-001 a quitté le dépôt à 23 h 12.',
        companyName: 'Transports Démo',
        deviceAssetTag: 'TEL-001',
        occurredAt: new Date('2026-09-05T21:12:00Z'),
        url: 'https://admin.exemple.fr/alerts',
      });

      expect(result.ok).toBe(true);

      const text = channel.text({
        alertId: 'x',
        type: AlertType.AFTER_RETURN_EXIT,
        severity: 'CRITICAL',
        title: 'Sortie du dépôt après le retour',
        body: 'TEL-001 a quitté le dépôt à 23 h 12.',
        companyName: 'Transports Démo',
        deviceAssetTag: 'TEL-001',
        occurredAt: new Date('2026-09-05T21:12:00Z'),
        url: 'https://admin.exemple.fr/alerts',
      });

      expect(text).toContain('TEL-001');
      expect(text).toContain('Transports Démo');
      expect(text).toContain('https://admin.exemple.fr/alerts');
    });

    it('se déclare non configuré sans relais SMTP', async () => {
      const channel = new EmailChannel(undefined, 'alertes@exemple.fr');

      expect(channel.configured).toBe(false);
      expect((await channel.send('a@exemple.fr', {} as never)).ok).toBe(false);
    });
  });

  describe('charge utile du webhook', () => {
    it('reste plate et lisible par un intermédiaire', async () => {
      const payload = new WebhookChannel().payload({
        alertId: 'a1',
        type: AlertType.DEVICE_TAMPERING,
        severity: 'HIGH',
        title: 'Position simulée détectée',
        body: 'TEL-002 a transmis 4 positions simulées.',
        companyName: 'Transports Démo',
        deviceAssetTag: 'TEL-002',
        occurredAt: new Date('2026-09-05T12:00:00Z'),
      });

      // Aucun objet imbriqué : celui qui branche un Slack ou un n8n n'a pas à
      // déplier une structure pour afficher une ligne.
      for (const value of Object.values(payload)) {
        expect(typeof value === 'object' && value !== null).toBe(false);
      }
      expect(payload.text).toBe(
        '[HIGH] Position simulée détectée — TEL-002 a transmis 4 positions simulées.',
      );
    });
  });

  it('indique quels canaux sont prêts', () => {
    // Sans SMTP_URL dans l'environnement de test, le courriel doit se déclarer
    // absent — et non prêt à échouer à chaque alerte.
    expect(notifications.readiness.webhook).toBe(true);
    expect(notifications.readiness.email).toBe(false);
  });

  it('n’expose pas la configuration de notification aux téléphones', async () => {
    // Les adresses de l'exploitation vivent dans Company.settings ; les
    // réglages des terminaux viennent d'une autre table. Les confondre
    // enverrait des adresses de courriel sur chaque téléphone du parc.
    await configure({ email: { recipients: ['exploitation@exemple.fr'] } });
    const device = await seedDevice(ctx, company, `TEL-NOTIF-${uniqueSuffix()}`);

    const settings = await TenantContext.system(() =>
      ctx.app
        .get(SettingsService)
        .resolveForDevice(company.company.id, device.id, device.depotId),
    );

    expect(JSON.stringify(settings)).not.toContain('exploitation@exemple.fr');
    // Et la configuration est bien là où on l'attend, côté entreprise.
    expect(await notifications.configFor(company.company.id)).not.toBeNull();
  });
});
