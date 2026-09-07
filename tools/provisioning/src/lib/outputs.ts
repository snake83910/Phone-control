import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  maskToken,
  payloadJson,
  renderPng,
  type ErrorCorrectionLevel,
  type ProvisioningPayload,
} from '@phone-control/provisioning-payload';
import { buildSheet, type LabelData } from './sheet';

/**
 * Écriture des livrables d'une campagne de mise en service.
 *
 * Tout ce qui sort d'ici contient des jetons d'enrôlement : des secrets à durée
 * de vie limitée, valables une fois, suffisants pour rattacher un téléphone au
 * parc de l'entreprise. Le répertoire de sortie est donc traité comme tel — il
 * pose son propre `.gitignore` en arrivant, et les fichiers sont créés en accès
 * restreint là où le système le permet.
 */

export interface DeviceArtifact {
  assetTag: string;
  deviceId: string;
  depotName?: string | null;
  kioskMode?: string | null;
  token: string;
  expiresAt: Date;
  payload: ProvisioningPayload;
}

export interface WriteOptions {
  errorCorrectionLevel?: ErrorCorrectionLevel;
  pageSize?: 'A4' | 'LETTER';
  labelsPerPage?: number;
  companyName?: string;
  generatedAt?: Date;
}

export interface WrittenFiles {
  directory: string;
  sheet: string;
  manifest: string;
  qrCodes: string[];
  payloads: string[];
}

/** Nom de fichier sûr : les étiquettes sont déjà contraintes, on double la garde. */
function safeName(assetTag: string): string {
  return assetTag.replace(/[^A-Za-z0-9._-]/g, '_');
}

function writeSecret(path: string, content: Buffer | string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

const stamp = (date: Date): string =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;

export async function writeArtifacts(
  directory: string,
  artifacts: DeviceArtifact[],
  options: WriteOptions = {},
): Promise<WrittenFiles> {
  const generatedAt = options.generatedAt ?? new Date();
  const qrDirectory = join(directory, 'qr');
  const payloadDirectory = join(directory, 'payload');

  mkdirSync(qrDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(payloadDirectory, { recursive: true, mode: 0o700 });

  // Ceinture et bretelles : même si le répertoire de sortie est déplacé dans un
  // dépôt Git, son contenu n'y entrera pas.
  writeFileSync(
    join(directory, '.gitignore'),
    [
      '# Ce répertoire contient des jetons d\'enrôlement : ce sont des secrets.',
      '# Rien de ce qu\'il contient ne doit entrer dans Git.',
      '*',
      '',
    ].join('\n'),
  );

  const qrCodes: string[] = [];
  const payloads: string[] = [];
  const labels: LabelData[] = [];

  for (const artifact of artifacts) {
    const name = safeName(artifact.assetTag);
    const json = payloadJson(artifact.payload);

    const qrPath = join(qrDirectory, `${name}.png`);
    writeSecret(qrPath, await renderPng(json, options.errorCorrectionLevel));
    qrCodes.push(qrPath);

    const payloadPath = join(payloadDirectory, `${name}.json`);
    writeSecret(payloadPath, `${JSON.stringify(artifact.payload, null, 2)}\n`);
    payloads.push(payloadPath);

    labels.push({
      assetTag: artifact.assetTag,
      depotName: artifact.depotName,
      kioskMode: artifact.kioskMode,
      expiresAt: artifact.expiresAt,
      maskedToken: maskToken(artifact.token),
      payload: json,
    });
  }

  const sheetPath = join(directory, `planche-${stamp(generatedAt)}.pdf`);
  writeSecret(
    sheetPath,
    await buildSheet(labels, {
      pageSize: options.pageSize,
      labelsPerPage: options.labelsPerPage,
      errorCorrectionLevel: options.errorCorrectionLevel,
      companyName: options.companyName,
      generatedAt,
    }),
  );

  const manifestPath = join(directory, 'manifeste.csv');
  writeSecret(manifestPath, buildManifest(artifacts));

  return {
    directory,
    sheet: sheetPath,
    manifest: manifestPath,
    qrCodes,
    payloads,
  };
}

/**
 * Manifeste de campagne.
 *
 * Il ne contient **aucun jeton en clair** : c'est le document qu'on garde, qu'on
 * envoie au responsable de parc, qu'on rapproche des téléphones à la réception.
 * Le jeton masqué suffit à faire ce rapprochement.
 */
export function buildManifest(artifacts: DeviceArtifact[]): string {
  const header = 'etiquette;identifiant_appareil;depot;mode;jeton_masque;expire_le';
  const lines = artifacts.map((artifact) =>
    [
      artifact.assetTag,
      artifact.deviceId,
      artifact.depotName ?? '',
      artifact.kioskMode ?? '',
      maskToken(artifact.token),
      artifact.expiresAt.toISOString(),
    ].join(';'),
  );
  return [header, ...lines, ''].join('\n');
}
