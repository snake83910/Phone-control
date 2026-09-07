import { ProvisioningError } from '@phone-control/provisioning-payload';

/**
 * Lecture du fichier de parc.
 *
 * Le fichier vient d'un tableur, et le plus souvent d'un tableur français :
 * séparateur point-virgule, marque d'ordre d'octets en tête, accents dans les
 * en-têtes, retours chariot Windows. Refuser ces fichiers reviendrait à faire
 * retaper la liste du parc à la main — c'est-à-dire à introduire des fautes de
 * frappe dans des étiquettes qu'on collera ensuite sur des téléphones.
 *
 * Le format attendu, minimal : une colonne d'étiquettes. Tout le reste est
 * facultatif.
 *
 *     asset_tag;serial;depot;kiosk_mode
 *     TEL-001;R58N70ABCDE;Lyon Est;KIOSK
 */

const DELIMITERS = [';', ',', '\t'] as const;

/** Étiquette d'inventaire : même contrainte que l'API (CreateDeviceDto). */
export const ASSET_TAG_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

export const KIOSK_MODES = ['KIOSK', 'RESTRICTED', 'STANDARD'] as const;
export type KioskMode = (typeof KIOSK_MODES)[number];

export interface FleetRow {
  assetTag: string;
  serialNumber?: string;
  depot?: string;
  kioskMode?: KioskMode;
  /** Numéro de ligne dans le fichier, en comptant l'en-tête. Sert aux messages. */
  line: number;
}

/**
 * Devine le séparateur en comptant les occurrences hors guillemets sur la
 * première ligne. Le point-virgule gagne à égalité : c'est le défaut des
 * tableurs en locale française, et le cas le plus fréquent ici.
 */
export function detectDelimiter(firstLine: string): string {
  let best = ';';
  let bestCount = -1;

  for (const candidate of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let index = 0; index < firstLine.length; index++) {
      const char = firstLine[index];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }

  return best;
}

/** Découpe le texte en lignes de champs, en respectant les guillemets. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Normalise un en-tête : accents retirés, minuscules, séparateurs unifiés.
 * `Dépôt` et `DEPOT` et `depot ` désignent la même colonne.
 */
function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

const HEADER_ALIASES: Record<string, keyof Omit<FleetRow, 'line'>> = {
  asset_tag: 'assetTag',
  assettag: 'assetTag',
  etiquette: 'assetTag',
  identifiant: 'assetTag',
  telephone: 'assetTag',
  serial: 'serialNumber',
  serialnumber: 'serialNumber',
  serial_number: 'serialNumber',
  numero_de_serie: 'serialNumber',
  n_de_serie: 'serialNumber',
  serie: 'serialNumber',
  depot: 'depot',
  site: 'depot',
  agence: 'depot',
  kiosk_mode: 'kioskMode',
  kioskmode: 'kioskMode',
  mode: 'kioskMode',
  mode_kiosque: 'kioskMode',
};

export interface ParsedFleet {
  rows: FleetRow[];
  /** Colonnes du fichier qui n'ont pas été reconnues : signalées, jamais bloquantes. */
  ignoredColumns: string[];
  delimiter: string;
}

export function parseFleetCsv(text: string): ParsedFleet {
  const withoutBom = text.replace(/^\ufeff/, '');
  const trimmed = withoutBom.trim();

  if (trimmed.length === 0) {
    throw new ProvisioningError('Le fichier de parc est vide.');
  }

  const delimiter = detectDelimiter(trimmed.split('\n')[0]);
  const table = parseDelimited(trimmed, delimiter).filter(
    (row) => row.some((cell) => cell.trim().length > 0),
  );

  const headerCells = table[0].map((cell) => normalizeHeader(cell));
  const mapping = headerCells.map((cell) => HEADER_ALIASES[cell]);
  const ignoredColumns = headerCells.filter((cell, index) => !mapping[index] && cell.length > 0);

  if (!mapping.includes('assetTag')) {
    throw new ProvisioningError(
      "Le fichier ne comporte pas de colonne d'étiquette d'inventaire.",
      `En-têtes reconnus pour cette colonne : ${Object.entries(HEADER_ALIASES)
        .filter(([, value]) => value === 'assetTag')
        .map(([key]) => key)
        .join(', ')}.`,
    );
  }

  const rows: FleetRow[] = [];
  const seen = new Map<string, number>();

  for (let index = 1; index < table.length; index++) {
    const line = index + 1;
    const cells = table[index];
    const row: Partial<FleetRow> = {};

    mapping.forEach((field, column) => {
      if (!field) return;
      const value = (cells[column] ?? '').trim();
      if (value.length > 0) row[field] = value as never;
    });

    const assetTag = (row.assetTag ?? '').toUpperCase();
    if (assetTag.length === 0) {
      throw new ProvisioningError(`Ligne ${line} : étiquette d'inventaire manquante.`);
    }
    if (!ASSET_TAG_PATTERN.test(assetTag)) {
      throw new ProvisioningError(
        `Ligne ${line} : étiquette « ${assetTag} » refusée.`,
        'Majuscules, chiffres et tirets, de 2 à 32 caractères (exemple : TEL-023).',
      );
    }

    const previous = seen.get(assetTag);
    if (previous !== undefined) {
      throw new ProvisioningError(
        `Ligne ${line} : l'étiquette « ${assetTag} » est déjà présente ligne ${previous}.`,
        'Deux téléphones ne peuvent pas porter la même étiquette : le second écraserait le premier.',
      );
    }
    seen.set(assetTag, line);

    if (row.kioskMode) {
      const mode = String(row.kioskMode).toUpperCase();
      if (!(KIOSK_MODES as readonly string[]).includes(mode)) {
        throw new ProvisioningError(
          `Ligne ${line} : mode kiosque « ${row.kioskMode} » inconnu.`,
          `Valeurs acceptées : ${KIOSK_MODES.join(', ')}.`,
        );
      }
      row.kioskMode = mode as KioskMode;
    }

    rows.push({ ...row, assetTag, line } as FleetRow);
  }

  if (rows.length === 0) {
    throw new ProvisioningError("Le fichier ne contient aucune ligne de téléphone.");
  }

  return { rows, ignoredColumns, delimiter };
}
