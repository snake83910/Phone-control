import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Protection de la valeur des badges — cf. docs/07-securite.md §3.
 *
 * Le Code 128 est un IDENTIFIANT, pas un secret : il est imprimé sur un badge et
 * donc photocopiable. On ne cherche pas à le protéger comme un mot de passe,
 * mais à empêcher qu'une fuite de la base ne livre la liste des numéros.
 *
 * D'où le choix d'un HMAC-SHA256 avec poivre plutôt qu'Argon2 :
 *  - la recherche doit être un accès par index à chaque scan (millions de lignes) ;
 *  - un hachage lent serait ici inutilisable, et inutile.
 */

export class BadgeNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadgeNormalizationError';
  }
}

/**
 * Normalisation v1 — FIGÉE.
 *
 * Format confirmé par le client : numérique, 8 chiffres (exemple : 14557719).
 * La normalisation reste volontairement un peu plus large que ce format afin de
 * tolérer les variations de lecture des scanners (espaces, tirets, retours
 * chariot, préfixes alphabétiques éventuels) sans changer de version.
 *
 * Règles :
 *   1. suppression des espaces et caractères de contrôle en tête et en fin ;
 *   2. passage en majuscules ;
 *   3. suppression de tout caractère hors [A-Z0-9] (tirets, points, espaces) ;
 *   4. LES ZÉROS DE TÊTE SONT CONSERVÉS — « 01455771 » ≠ « 1455771 ».
 *
 * ATTENTION : modifier cette fonction rend introuvables tous les badges déjà
 * enregistrés. Toute évolution passe par un incrément de BADGE_HASH_VERSION et
 * un réenregistrement des badges.
 */
export function normalizeBarcode(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadgeNormalizationError('Valeur de code-barres absente.');
  }

  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (normalized.length < 4 || normalized.length > 32) {
    throw new BadgeNormalizationError(
      `Longueur de code-barres invalide après normalisation : ${normalized.length} ` +
        `caractères (attendu entre 4 et 32).`,
    );
  }

  return normalized;
}

/** Masque d'affichage : 14557719 -> ****7719. Jamais la valeur complète. */
export function maskBarcode(last4: string, length: number): string {
  const hidden = Math.max(length - last4.length, 0);
  return '*'.repeat(hidden) + last4;
}

@Injectable()
export class BadgeHashService {
  private readonly pepper: Buffer;
  private readonly masterKey: Buffer;
  readonly hashVersion: number;

  constructor(private readonly config: ConfigService) {
    this.pepper = Buffer.from(
      this.config.getOrThrow<string>('BADGE_HMAC_PEPPER'),
      'utf8',
    );
    this.masterKey = Buffer.from(
      this.config.getOrThrow<string>('DEVICE_MASTER_KEY'),
      'utf8',
    );
    this.hashVersion = this.config.get<number>('BADGE_HASH_VERSION') ?? 1;
  }

  /**
   * Empreinte serveur d'un code-barres. La version est incluse dans le message
   * haché : deux versions de normalisation ne peuvent pas produire de collision
   * silencieuse.
   */
  hash(rawOrNormalized: string, alreadyNormalized = false): Buffer {
    const value = alreadyNormalized
      ? rawOrNormalized
      : normalizeBarcode(rawOrNormalized);
    return createHmac('sha256', this.pepper)
      .update(`v${this.hashVersion}:${value}`, 'utf8')
      .digest();
  }

  /** Comparaison à temps constant, par principe. */
  matches(candidate: Buffer, stored: Buffer): boolean {
    if (candidate.length !== stored.length) return false;
    return timingSafeEqual(candidate, stored);
  }

  /**
   * Clé HMAC propre à un appareil, dérivée par HKDF de la clé maîtresse.
   *
   * C'est le mécanisme qui rend la liste de badges hors ligne inutilisable
   * ailleurs : chaque téléphone reçoit des empreintes calculées avec SA clé.
   * Un terminal volé et déchiffré ne compromet pas les autres.
   */
  deriveDeviceKey(deviceId: string): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        this.masterKey,
        Buffer.from(deviceId, 'utf8'),
        Buffer.from('offline-badge-v1', 'utf8'),
        32,
      ),
    );
  }

  /** Empreinte d'un badge telle que l'appareil la recalculera hors ligne. */
  deviceScopedHash(deviceKey: Buffer, normalizedBarcode: string): string {
    return createHmac('sha256', deviceKey)
      .update(`v${this.hashVersion}:${normalizedBarcode}`, 'utf8')
      .digest('base64url');
  }

  /** Décompose une valeur brute en tout ce que la base doit stocker. */
  describe(raw: string): {
    normalized: string;
    hash: Buffer;
    last4: string;
    length: number;
    hashVersion: number;
  } {
    const normalized = normalizeBarcode(raw);
    return {
      normalized,
      hash: this.hash(normalized, true),
      last4: normalized.slice(-4),
      length: normalized.length,
      hashVersion: this.hashVersion,
    };
  }
}
