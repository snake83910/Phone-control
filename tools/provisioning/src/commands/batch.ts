import { readFileSync } from 'node:fs';
import { ApiClient, type DepotSummary, type DeviceSummary } from '../lib/api';
import { boolean, optionalString, requireString } from '../lib/args';
import { loadConfig, type ProvisioningConfig, type Secrets } from '../lib/config';
import { ASSET_TAG_PATTERN, parseFleetCsv, type FleetRow } from '../lib/csv';
import { writeArtifacts, type DeviceArtifact } from '../lib/outputs';
import {
  ProvisioningError,
  buildPayload,
  maskToken,
  validatePayload,
} from '@phone-control/provisioning-payload';
import { ui } from '../lib/ui';
import { report } from './payload';

/**
 * Mise en service d'un parc, de la liste de téléphones aux étiquettes à coller.
 *
 * L'ordre des opérations n'est pas indifférent. La configuration est vérifiée
 * **avant** que le moindre jeton ne soit émis : un jeton est à usage unique et
 * daté, en produire deux cents avec une empreinte de signature erronée revient
 * à les jeter, et à recommencer après expiration ou révocation manuelle.
 */

/** Comparaison de noms de dépôts telle qu'un humain les écrit dans un tableur. */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolveDepot(
  depots: DepotSummary[],
  name: string | undefined,
  line: number,
): DepotSummary | undefined {
  if (!name) return undefined;

  const wanted = normalizeName(name);
  const matches = depots.filter((depot) => normalizeName(depot.name) === wanted);

  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    throw new ProvisioningError(
      `Ligne ${line} : le dépôt « ${name} » n'existe pas.`,
      `Dépôts connus : ${depots.map((depot) => depot.name).join(', ') || 'aucun'}. ` +
        'Créez-le dans le dashboard avant la campagne.',
    );
  }

  throw new ProvisioningError(
    `Ligne ${line} : « ${name} » désigne ${matches.length} dépôts.`,
    'Renommez-les pour les distinguer, ou renseignez leur identifiant.',
  );
}

interface PreparedRow {
  row: FleetRow;
  depot?: DepotSummary;
  existing?: DeviceSummary;
}

/**
 * Vérifie la configuration avec un jeton factice, avant tout appel qui écrit.
 *
 * Le jeton factice respecte le format réel : il traverse donc exactement les
 * mêmes contrôles que les vrais, y compris la mesure de taille du QR code.
 */
function checkConfigurationUpfront(config: ProvisioningConfig, secrets: Secrets): void {
  const payload = buildPayload(config.provisioning, {
    enrollmentToken: 'ETK-AAAAAAAA-AAAAAAAA',
    wifiPassword: secrets.wifiPassword,
  });

  const result = validatePayload(payload, {
    packageName: config.provisioning.packageName,
    allowInsecureDownload: config.provisioning.allowInsecureDownload,
  });

  ui.heading('Vérification de la configuration');
  report(result);

  if (result.errors.length > 0) {
    throw new ProvisioningError(
      'Configuration invalide : aucun jeton n’a été émis.',
      'Corrigez les points ci-dessus, puis relancez. Rien n’a été modifié côté serveur.',
    );
  }
}

async function connect(config: ProvisioningConfig, secrets: Secrets): Promise<ApiClient> {
  if (!secrets.adminPassword) {
    throw new ProvisioningError(
      "Le mot de passe de l'administrateur n'est pas renseigné.",
      'Définissez PC_ADMIN_PASSWORD, ou passez un fichier .env avec --env-file.',
    );
  }

  const client = new ApiClient(config.api.baseUrl, config.api.timeoutMs);
  await client.login(config.api.email, secrets.adminPassword);
  ui.success(`Connecté à ${config.api.baseUrl} en tant que ${config.api.email}.`);
  return client;
}

export async function runBatch(flags: Record<string, string | boolean>): Promise<void> {
  const { config, secrets } = loadConfig(requireString(flags, 'config'));
  const dryRun = boolean(flags, 'dry-run');

  const rows = readFleet(flags);
  ui.success(`${rows.length} téléphone(s) dans la liste.`);

  checkConfigurationUpfront(config, secrets);

  const client = await connect(config, secrets);
  const [depots, devices] = await Promise.all([client.listDepots(), client.listDevices()]);

  const byAssetTag = new Map(devices.map((device) => [device.assetTag, device]));
  const prepared: PreparedRow[] = rows.map((row) => ({
    row,
    depot: resolveDepot(depots, row.depot, row.line),
    existing: byAssetTag.get(row.assetTag),
  }));

  ui.heading('Plan de la campagne');
  ui.table(
    ['Étiquette', 'Dépôt', 'Mode', 'Action'],
    prepared.map((item) => [
      item.row.assetTag,
      item.depot?.name ?? item.existing?.depot?.name ?? '—',
      item.row.kioskMode ?? 'KIOSK',
      item.existing ? 'réutiliser la fiche existante' : 'créer la fiche',
    ]),
  );

  for (const item of prepared) {
    if (!item.existing || !item.depot || !item.existing.depot) continue;
    if (item.existing.depot.id !== item.depot.id) {
      ui.warn(
        `${item.row.assetTag} est rattaché au dépôt « ${item.existing.depot.name} » côté ` +
          `serveur, le fichier indique « ${item.depot.name} ». La fiche existante fait foi : ` +
          'modifiez-la dans le dashboard si le fichier a raison.',
      );
    }
  }

  if (dryRun) {
    ui.line('');
    ui.success('Simulation terminée : aucune fiche créée, aucun jeton émis.');
    return;
  }

  ui.heading('Émission des jetons');
  const artifacts: DeviceArtifact[] = [];

  for (const item of prepared) {
    const device =
      item.existing ??
      (await client.createDevice({
        assetTag: item.row.assetTag,
        depotId: item.depot?.id,
        kioskMode: item.row.kioskMode,
      }));

    const token = await client.createEnrollmentToken(device.id);
    const expiresAt = new Date(token.expiresAt);

    artifacts.push({
      assetTag: device.assetTag,
      deviceId: device.id,
      depotName: item.depot?.name ?? device.depot?.name ?? null,
      kioskMode: item.row.kioskMode ?? null,
      token: token.token,
      expiresAt,
      payload: buildPayload(config.provisioning, {
        enrollmentToken: token.token,
        wifiPassword: secrets.wifiPassword,
      }),
    });

    ui.step(
      `${device.assetTag} — jeton ${maskToken(token.token)}, ` +
        `valable jusqu'au ${expiresAt.toLocaleString('fr-FR')}`,
    );
  }

  await emit(flags, config, artifacts);
}

/** Un seul téléphone : mise en service à l'unité, remplacement, dépannage. */
export async function runDevice(flags: Record<string, string | boolean>): Promise<void> {
  const { config, secrets } = loadConfig(requireString(flags, 'config'));
  const assetTag = requireString(flags, 'asset-tag').toUpperCase();

  if (!ASSET_TAG_PATTERN.test(assetTag)) {
    throw new ProvisioningError(
      `Étiquette « ${assetTag} » refusée.`,
      'Majuscules, chiffres et tirets, de 2 à 32 caractères (exemple : TEL-023).',
    );
  }

  checkConfigurationUpfront(config, secrets);

  const client = await connect(config, secrets);
  const depotName = optionalString(flags, 'depot');
  const [depots, devices] = await Promise.all([client.listDepots(), client.listDevices()]);

  const depot = resolveDepot(depots, depotName, 1);
  const existing = devices.find((device) => device.assetTag === assetTag);

  const device =
    existing ??
    (await client.createDevice({
      assetTag,
      depotId: depot?.id,
      kioskMode: optionalString(flags, 'kiosk-mode'),
    }));

  const token = await client.createEnrollmentToken(device.id);

  ui.heading('Jeton émis');
  ui.detail('Étiquette', device.assetTag);
  ui.detail('Dépôt', depot?.name ?? device.depot?.name ?? 'non affecté');
  ui.detail('Jeton', maskToken(token.token));
  ui.detail("Valable jusqu'au", new Date(token.expiresAt).toLocaleString('fr-FR'));

  await emit(flags, config, [
    {
      assetTag: device.assetTag,
      deviceId: device.id,
      depotName: depot?.name ?? device.depot?.name ?? null,
      kioskMode: optionalString(flags, 'kiosk-mode') ?? null,
      token: token.token,
      expiresAt: new Date(token.expiresAt),
      payload: buildPayload(config.provisioning, {
        enrollmentToken: token.token,
        wifiPassword: secrets.wifiPassword,
      }),
    },
  ]);
}

function readFleet(flags: Record<string, string | boolean>): FleetRow[] {
  const path = requireString(flags, 'csv', 'Exemple fourni : examples/parc-exemple.csv');

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ProvisioningError(`Fichier de parc introuvable : ${path}`);
  }

  const fleet = parseFleetCsv(text);
  if (fleet.ignoredColumns.length > 0) {
    ui.warn(`Colonnes ignorées : ${fleet.ignoredColumns.join(', ')}.`);
  }
  return fleet.rows;
}

async function emit(
  flags: Record<string, string | boolean>,
  config: ProvisioningConfig,
  artifacts: DeviceArtifact[],
): Promise<void> {
  const directory = optionalString(flags, 'out') ?? config.output.dir;

  const written = await writeArtifacts(directory, artifacts, {
    errorCorrectionLevel: config.output.errorCorrectionLevel,
    pageSize: config.output.pageSize,
    labelsPerPage: config.output.labelsPerPage,
    companyName: optionalString(flags, 'company'),
  });

  ui.heading('Livrables');
  ui.detail('Planche à imprimer', written.sheet);
  ui.detail('Manifeste', written.manifest);
  ui.detail('QR codes', `${written.qrCodes.length} fichier(s) dans ${directory}/qr`);
  ui.detail('Charges utiles', `${written.payloads.length} fichier(s) dans ${directory}/payload`);

  ui.line('');
  ui.warn(
    `Ce répertoire contient des jetons d'enrôlement à usage unique. Il n'entre ni dans ` +
      'Git, ni dans une pièce jointe : imprimez la planche, puis effacez-le une fois ' +
      'les téléphones enrôlés.',
  );
}
