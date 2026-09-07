import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ProvisioningError,
  provisioningProfileSchema,
} from '@phone-control/provisioning-payload';

/**
 * Configuration de l'atelier.
 *
 * Un principe structure ce fichier : **aucun mot de passe n'a le droit d'y
 * figurer**. La configuration décrit un parc — adresse du serveur, composant
 * DPC, empreinte de signature, SSID — et se versionne sans risque. Les secrets
 * arrivent par l'environnement, où ils ne laissent pas de trace dans Git
 * (spécification §51 : « Aucun secret dans Git »).
 *
 * Le schéma est strict : une clé inconnue est une erreur, pas un silence. Une
 * faute de frappe sur `signatureChecksum` produirait sinon un QR code sans
 * empreinte, refusé par le téléphone après plusieurs minutes de provisioning.
 */

const outputSchema = z
  .object({
    dir: z.string().optional().default('out'),
    errorCorrectionLevel: z.enum(['L', 'M', 'Q', 'H']).optional().default('M'),
    pageSize: z.enum(['A4', 'LETTER']).optional().default('A4'),
    /** Étiquettes par planche : 6 tient confortablement sur une A4. */
    labelsPerPage: z.number().int().min(1).max(12).optional().default(6),
  })
  .strict();

const apiSchema = z
  .object({
    baseUrl: z.string().url(),
    email: z.string().email(),
    /** Délai d'attente réseau, en millisecondes. */
    timeoutMs: z.number().int().min(1000).max(120_000).optional().default(15_000),
  })
  .strict();

export const configSchema = z
  .object({
    api: apiSchema,
    provisioning: provisioningProfileSchema,
    output: outputSchema.optional().default({}),
  })
  .strict();

export type ProvisioningConfig = z.infer<typeof configSchema>;

export interface Secrets {
  /** Mot de passe de l'administrateur du dashboard (PC_ADMIN_PASSWORD). */
  adminPassword?: string;
  /** Clé du réseau Wi-Fi d'atelier (PC_WIFI_PASSWORD). */
  wifiPassword?: string;
}

export interface LoadedConfig {
  config: ProvisioningConfig;
  secrets: Secrets;
  path: string;
}

/**
 * Clés refusées dans le fichier : ce sont des secrets.
 *
 * Le message nomme la variable d'environnement à utiliser, sinon la règle
 * ressemble à une contrariété arbitraire et finira contournée.
 */
const FORBIDDEN_PATHS: ReadonlyArray<{ path: string; env: string }> = [
  { path: 'api.password', env: 'PC_ADMIN_PASSWORD' },
  { path: 'api.token', env: 'PC_ADMIN_PASSWORD' },
  { path: 'provisioning.wifi.password', env: 'PC_WIFI_PASSWORD' },
];

function valueAt(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

/** Vérifie qu'aucun secret n'a été écrit dans le fichier de configuration. */
export function assertNoSecretsInFile(raw: unknown): void {
  for (const forbidden of FORBIDDEN_PATHS) {
    if (valueAt(raw, forbidden.path) !== undefined) {
      throw new ProvisioningError(
        `La clé « ${forbidden.path} » est un secret : elle n'a pas sa place dans le fichier de configuration.`,
        `Renseignez la variable d'environnement ${forbidden.env} à la place ` +
          `(ou un fichier .env passé par --env-file, déjà ignoré par Git).`,
      );
    }
  }
}

/** Transforme une erreur zod en liste lisible « chemin : message ». */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  · ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
    .join('\n');
}

export function parseConfig(raw: unknown, path = '(mémoire)'): ProvisioningConfig {
  assertNoSecretsInFile(raw);

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ProvisioningError(
      `Configuration invalide (${path}) :\n${formatIssues(result.error)}`,
      'Voir provisioning.config.example.json pour un exemple complet.',
    );
  }
  return result.data;
}

/**
 * Charge la configuration, applique les surcharges d'environnement et récupère
 * les secrets.
 *
 * Les surcharges existent pour une raison pratique : un même fichier décrit le
 * parc, et l'on bascule entre recette et production par une variable, sans
 * dupliquer un fichier qu'on oublierait de tenir à jour.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ProvisioningError(
      `Fichier de configuration introuvable : ${path}`,
      'Copiez provisioning.config.example.json et adaptez-le, puis passez-le par --config.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProvisioningError(
      `Configuration illisible (${path}) : ${(error as Error).message}`,
    );
  }

  const config = parseConfig(raw, path);

  if (env.PC_API_URL) config.api.baseUrl = env.PC_API_URL;
  if (env.PC_ADMIN_EMAIL) config.api.email = env.PC_ADMIN_EMAIL;
  if (env.PC_SERVER_URL) config.provisioning.serverUrl = env.PC_SERVER_URL;
  if (env.PC_SIGNATURE_CHECKSUM) {
    config.provisioning.signatureChecksum = env.PC_SIGNATURE_CHECKSUM;
  }
  if (env.PC_APK_URL) config.provisioning.apkDownloadUrl = env.PC_APK_URL;

  return {
    config,
    secrets: {
      adminPassword: env.PC_ADMIN_PASSWORD,
      wifiPassword: env.PC_WIFI_PASSWORD,
    },
    path,
  };
}
