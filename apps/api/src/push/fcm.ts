import { createSign } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';

/**
 * Réveil des téléphones par Firebase Cloud Messaging.
 *
 * **Ce canal est un accélérateur, jamais une dépendance.** Le téléphone
 * interroge le serveur de lui-même — trente secondes en session, cinq minutes
 * verrouillé, quinze minutes la nuit (docs/02 §7). FCM ne fait que raccourcir
 * cette attente quand tout va bien : Play Services présent, Doze coopératif,
 * réseau disponible. Un parc sans services Google fonctionne, simplement moins
 * vite. C'est pourquoi rien ici ne fait échouer une commande.
 *
 * **Ce qui n'a jamais été exécuté contre Google.** Il n'existe pas de projet
 * Firebase pour ce système (prérequis P4 de docs/08). Ce qui est vérifié par
 * les tests : la forme de l'assertion JWT — signature comprise, contrôlée avec
 * la clé publique — et celle du message envoyé. Ce qui ne l'est pas : que Google
 * accepte l'une et délivre l'autre. La distinction est écrite ici parce qu'elle
 * ne se voit pas dans le code.
 */

export const serviceAccountSchema = z
  .object({
    project_id: z.string().min(1),
    client_email: z.string().email(),
    private_key: z.string().includes('PRIVATE KEY'),
  })
  .passthrough();

export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Durée de vie de l'assertion. Google refuse au-delà d'une heure. */
const ASSERTION_TTL_SECONDS = 3600;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/**
 * Assertion JWT signée, échangée contre un jeton d'accès.
 *
 * Écrite à la main plutôt qu'empruntée à `google-auth-library` : trente lignes
 * contre une dépendance de plus, pour un chemin qui ne peut de toute façon pas
 * être exercé ici. Et sous cette forme, la signature se vérifie en test avec la
 * clé publique correspondante — ce qu'une bibliothèque aurait rendu opaque.
 */
export function buildJwtAssertion(
  account: ServiceAccount,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(account.private_key)
    .toString('base64url');

  return `${signingInput}.${signature}`;
}

export interface WakePayload {
  /** Pourquoi le téléphone est réveillé. Sert au diagnostic, pas au comportement. */
  reason: string;
  /** Identifiant de commande, quand le réveil en concerne une. */
  commandId?: string;
}

/**
 * Message FCM.
 *
 * Un **data message**, jamais une notification : rien ne doit s'afficher à
 * l'écran d'un chauffeur. Le message ne transporte aucune instruction — il dit
 * seulement « viens voir ». Le téléphone se synchronise ensuite par le canal
 * authentifié habituel, et c'est ce qui empêche un message FCM falsifié de
 * commander quoi que ce soit.
 */
export function buildFcmMessage(
  fcmToken: string,
  payload: WakePayload,
): Record<string, unknown> {
  return {
    message: {
      token: fcmToken,
      data: {
        reason: payload.reason,
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
      },
      android: {
        priority: 'HIGH',
        // Le message n'a d'intérêt que tout de suite : un réveil livré deux
        // heures plus tard arriverait après la synchronisation périodique.
        ttl: '600s',
      },
    },
  };
}

export interface PushResult {
  ok: boolean;
  detail?: string;
}

export interface PushTransport {
  readonly name: string;
  readonly configured: boolean;
  send(fcmToken: string, payload: WakePayload): Promise<PushResult>;
}

/**
 * Transport par défaut : aucun.
 *
 * Sans projet Firebase, le système reste complet — les téléphones interrogent
 * le serveur d'eux-mêmes. Ce transport le dit dans les journaux au lieu de
 * laisser croire à un envoi.
 */
export class DisabledPushTransport implements PushTransport {
  readonly name = 'aucun';
  readonly configured = false;

  async send(): Promise<PushResult> {
    return { ok: false, detail: 'FCM non configuré : réveil laissé au sondage périodique' };
  }
}

type Fetcher = typeof fetch;

export class FcmTransport implements PushTransport {
  readonly name = 'fcm';
  readonly configured = true;

  private readonly logger = new Logger(FcmTransport.name);
  private accessToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  /** Jeton d'accès, mis en cache jusqu'à une minute avant son expiration. */
  async token(nowMs: number = Date.now()): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAtMs > nowMs) {
      return this.accessToken.value;
    }

    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: buildJwtAssertion(this.account, Math.floor(nowMs / 1000)),
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`échange du jeton refusé (HTTP ${response.status})`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('réponse sans access_token');

    this.accessToken = {
      value: body.access_token,
      expiresAtMs: nowMs + ((body.expires_in ?? 3600) - 60) * 1000,
    };
    return body.access_token;
  }

  async send(fcmToken: string, payload: WakePayload): Promise<PushResult> {
    try {
      const accessToken = await this.token();
      const response = await this.fetcher(
        `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(buildFcmMessage(fcmToken, payload)),
        },
      );

      if (response.status === 404 || response.status === 400) {
        // Jeton FCM périmé : le téléphone en fournira un nouveau au prochain
        // heartbeat. Ce n'est pas une panne, c'est le cycle de vie normal.
        return { ok: false, detail: `jeton FCM rejeté (HTTP ${response.status})` };
      }
      if (!response.ok) {
        return { ok: false, detail: `HTTP ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      this.logger.warn(`Réveil FCM impossible : ${(error as Error).message}`);
      return { ok: false, detail: (error as Error).message };
    }
  }
}

/**
 * Construit le transport à partir de la configuration.
 *
 * Une clé de service mal formée ne doit pas empêcher l'API de démarrer : on
 * journalise et l'on retombe sur le sondage périodique, qui suffit à faire
 * fonctionner le système.
 */
/**
 * Accepte le JSON tel quel, ou encodé en base64.
 *
 * ── Pourquoi les deux ───────────────────────────────────────────────────
 * Une clé de service fait deux bons kilo-octets, contient des guillemets, des
 * accolades et une clé privée dont les sauts de ligne sont échappés. Posée
 * telle quelle dans un fichier `.env`, elle traverse successivement le
 * lecteur de ce fichier, Docker Compose et le shell — et il suffit que l'un
 * des trois interprète un guillemet pour que `JSON.parse` échoue.
 *
 * L'échec serait discret : le transport se désactive, l'API démarre
 * normalement, les téléphones retombent sur le sondage de quinze minutes, et
 * personne ne s'aperçoit de rien avant le jour où un verrouillage urgent
 * n'arrive pas.
 *
 * Le base64 n'a aucun caractère qui gêne qui que ce soit. On accepte encore
 * le JSON brut, qui fonctionne et qui est plus lisible pour qui débogue.
 */
function decoderClefDeService(valeur: string): string {
  const nettoye = valeur.trim();
  if (nettoye.startsWith('{')) return nettoye;

  // Ni JSON, ni base64 valide : on rend la valeur d'origine pour que le
  // message d'erreur de `JSON.parse` parle de ce que l'exploitant a écrit,
  // et non d'un décodage qu'il n'a pas demandé.
  const decode = Buffer.from(nettoye, 'base64').toString('utf8');
  return decode.trimStart().startsWith('{') ? decode : nettoye;
}

export function createPushTransport(
  serviceAccountJson: string | undefined,
  logger: Logger,
): PushTransport {
  if (!serviceAccountJson?.trim()) return new DisabledPushTransport();

  try {
    const account = serviceAccountSchema.parse(
      JSON.parse(decoderClefDeService(serviceAccountJson)),
    );
    logger.log(`Réveil FCM actif pour le projet ${account.project_id}.`);
    return new FcmTransport(account);
  } catch (error) {
    logger.error(
      `Clé de service FCM inutilisable (${(error as Error).message}) : ` +
        'les téléphones seront réveillés par le sondage périodique.',
    );
    return new DisabledPushTransport();
  }
}
