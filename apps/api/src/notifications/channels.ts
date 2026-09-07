import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

/**
 * Canaux de sortie.
 *
 * Deux seulement, et c'est un choix : un webhook couvre Slack, Teams,
 * Mattermost, n8n et la plupart des passerelles maison ; le courrier couvre le
 * reste. Le SMS demande un compte chez un opérateur, une adresse d'expéditeur
 * déclarée et un budget — il sera ajouté quand ces trois choses existeront,
 * plutôt qu'écrit à l'aveugle aujourd'hui.
 *
 * Chaque canal **dit s'il est configuré**. Un canal absent ne fait pas échouer
 * l'alerte : il se signale, et la notification est comptée comme non délivrée.
 * Une alerte qui ne part pas est un incident d'exploitation ; une alerte qui
 * fait tomber le serveur en est un plus grave.
 */

export interface NotificationMessage {
  title: string;
  body: string;
  severity: string;
  type: string;
  companyName: string;
  alertId: string;
  deviceAssetTag?: string | null;
  occurredAt: Date;
  /** Lien vers la fiche de l'alerte dans le dashboard, si l'URL est connue. */
  url?: string;
}

export interface DeliveryResult {
  ok: boolean;
  detail?: string;
}

export interface NotificationChannel {
  readonly name: 'webhook' | 'email';
  readonly configured: boolean;
  send(destination: string, message: NotificationMessage): Promise<DeliveryResult>;
}

/**
 * Webhook JSON.
 *
 * La charge utile est volontairement plate et stable : elle est destinée à être
 * transformée par un intermédiaire (Slack, n8n) que nous ne maîtrisons pas, et
 * un format imbriqué compliquerait le travail de celui qui la branche.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook' as const;
  readonly configured = true;

  private readonly logger = new Logger(WebhookChannel.name);

  constructor(private readonly timeoutMs = 8_000) {}

  async send(url: string, message: NotificationMessage): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.payload(message)),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { ok: false, detail: `HTTP ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      const reason =
        (error as Error).name === 'AbortError'
          ? `délai de ${this.timeoutMs} ms dépassé`
          : (error as Error).message;
      this.logger.warn(`Webhook injoignable : ${reason}`);
      return { ok: false, detail: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  payload(message: NotificationMessage): Record<string, unknown> {
    return {
      alertId: message.alertId,
      type: message.type,
      severity: message.severity,
      title: message.title,
      message: message.body,
      company: message.companyName,
      device: message.deviceAssetTag ?? null,
      occurredAt: message.occurredAt.toISOString(),
      url: message.url ?? null,
      // Champ de commodité : la plupart des intégrations n'affichent qu'une
      // ligne, et la composer côté destinataire est une corvée récurrente.
      text: `[${message.severity}] ${message.title} — ${message.body}`,
    };
  }
}

/**
 * Courrier électronique.
 *
 * Le transport vient de la configuration (`SMTP_URL`). Sans elle, le canal se
 * déclare non configuré et n'essaie rien : mieux vaut un canal explicitement
 * absent qu'un envoi qui échoue silencieusement à chaque alerte.
 */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email' as const;

  private readonly logger = new Logger(EmailChannel.name);
  private readonly transporter: Transporter | null;

  constructor(
    smtpUrl: string | undefined,
    private readonly from: string,
    /** Transport de test : compose le message sans l'envoyer. */
    transporter?: Transporter,
  ) {
    this.transporter =
      transporter ?? (smtpUrl ? createTransport(smtpUrl) : null);
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async send(recipients: string, message: NotificationMessage): Promise<DeliveryResult> {
    if (!this.transporter) {
      return { ok: false, detail: 'SMTP_URL non renseignée' };
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: recipients,
        subject: `[${message.severity}] ${message.title}`,
        text: this.text(message),
      });
      return { ok: true };
    } catch (error) {
      this.logger.warn(`Envoi de courriel impossible : ${(error as Error).message}`);
      return { ok: false, detail: (error as Error).message };
    }
  }

  /**
   * Corps du message.
   *
   * En texte brut, sans mise en forme : ces courriels sont lus sur un téléphone,
   * souvent en marchant, et parfois transférés à un tiers. Ce qui compte est
   * qu'on sache en trois lignes de quel téléphone il s'agit et quoi faire.
   */
  text(message: NotificationMessage): string {
    const lines = [
      message.body,
      '',
      `Entreprise : ${message.companyName}`,
      message.deviceAssetTag ? `Téléphone : ${message.deviceAssetTag}` : null,
      `Gravité : ${message.severity}`,
      `Survenue le : ${message.occurredAt.toISOString()}`,
      message.url ? '' : null,
      message.url ? `Fiche de l'alerte : ${message.url}` : null,
    ];
    return lines.filter((line) => line !== null).join('\n');
  }
}
