import { readFileSync, writeFileSync } from 'node:fs';
import { boolean, optionalString, requireString } from '../lib/args';
import { loadConfig } from '../lib/config';
import {
  ProvisioningError,
  buildPayload,
  payloadJson,
  qrMatrix,
  recommendedPrintSizeMm,
  redactPayload,
  validatePayload,
  type ProvisioningPayload,
} from '@phone-control/provisioning-payload';
import { ui } from '../lib/ui';

/**
 * Affiche le résultat d'une vérification.
 *
 * Les avertissements ne bloquent pas : ils décrivent des choix discutables, pas
 * des impossibilités. La distinction compte, sinon tout devient bloquant et
 * plus rien n'est lu.
 */
export function report(result: { errors: string[]; warnings: string[] }): void {
  for (const warning of result.warnings) ui.warn(warning);
  for (const error of result.errors) ui.fail(error);

  if (result.errors.length === 0 && result.warnings.length === 0) {
    ui.success('Charge utile conforme, sans réserve.');
  } else if (result.errors.length === 0) {
    ui.success(
      `Charge utile utilisable — ${result.warnings.length} point(s) à connaître.`,
    );
  }
}

function describe(payload: ProvisioningPayload, level: 'L' | 'M' | 'Q' | 'H'): void {
  const json = payloadJson(payload);
  const matrix = qrMatrix(json, level);

  ui.heading('QR code');
  ui.detail('Taille encodée', `${Buffer.byteLength(json, 'utf8')} octets`);
  ui.detail('Version', `${matrix.version} (${matrix.size} × ${matrix.size} modules)`);
  ui.detail('Correction', level);
  ui.detail('Impression', `au moins ${recommendedPrintSizeMm(matrix)} mm de côté`);
}

/** Fabrique une charge utile à partir d'un jeton déjà émis. Aucun accès réseau. */
export async function runPayload(flags: Record<string, string | boolean>): Promise<void> {
  const { config, secrets } = loadConfig(requireString(flags, 'config'));
  const token = requireString(
    flags,
    'token',
    "Le jeton est produit par le dashboard, ou par « pcprov device » qui l'appelle pour vous.",
  );

  const payload = buildPayload(config.provisioning, {
    enrollmentToken: token,
    wifiPassword: secrets.wifiPassword,
    serverUrl: optionalString(flags, 'server-url'),
  });

  ui.heading('Charge utile de provisioning');
  ui.line(
    JSON.stringify(boolean(flags, 'reveal') ? payload : redactPayload(payload), null, 2),
  );
  if (!boolean(flags, 'reveal')) {
    ui.line('');
    ui.info('(jeton masqué — utilisez --reveal pour le voir en clair)');
  }

  describe(payload, config.output.errorCorrectionLevel);

  ui.heading('Vérification');
  const result = validatePayload(payload, {
    packageName: config.provisioning.packageName,
    allowInsecureDownload: config.provisioning.allowInsecureDownload,
  });
  report(result);

  const out = optionalString(flags, 'out');
  if (out) {
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    ui.line('');
    ui.success(`Écrit dans ${out} — ce fichier contient un jeton : ne le versionnez pas.`);
  }

  if (result.errors.length > 0) {
    throw new ProvisioningError(
      "La charge utile comporte des erreurs : le provisioning échouerait sur le téléphone.",
    );
  }
}

/** Contrôle une charge utile déjà écrite, par exemple avant une réimpression. */
export async function runVerify(flags: Record<string, string | boolean>): Promise<void> {
  const path = requireString(flags, 'payload');

  let payload: ProvisioningPayload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ProvisioningError(`Charge utile illisible (${path}) : ${(error as Error).message}`);
  }

  const configPath = optionalString(flags, 'config');
  const config = configPath ? loadConfig(configPath).config : undefined;
  const level = config?.output.errorCorrectionLevel ?? 'M';

  ui.heading(`Vérification de ${path}`);
  describe(payload, level);
  ui.line('');

  const result = validatePayload(payload, {
    packageName: config?.provisioning.packageName,
    allowInsecureDownload: config?.provisioning.allowInsecureDownload,
  });
  report(result);

  if (result.errors.length > 0) {
    throw new ProvisioningError('Cette charge utile ne provisionnera aucun téléphone.');
  }
}
