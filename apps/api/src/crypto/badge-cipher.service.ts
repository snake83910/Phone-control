import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Chiffrement réversible de la valeur du badge (AES-256-GCM).
 *
 * POURQUOI CETTE COLONNE EXISTE — contrainte découverte à l'implémentation,
 * et qui mérite d'être énoncée clairement :
 *
 * L'authentification hors ligne repose sur des empreintes calculées avec une
 * clé propre à chaque appareil (docs/05 §3.1). Le serveur doit donc pouvoir
 * calculer HMAC(clé_appareil, valeur_normalisée) pour chaque badge autorisé sur
 * chaque téléphone — y compris pour une affectation créée des mois après
 * l'enregistrement du badge. Or le HMAC serveur n'est pas inversible.
 *
 * Conclusion : le mode hors ligne EXIGE que le serveur puisse retrouver la
 * valeur normalisée. C'est un compromis, pas un oubli.
 *
 * Il est encadré ainsi :
 *  - clé DISTINCTE du poivre de hachage (compromettre l'une ne suffit pas) ;
 *  - clé destinée à un KMS en production, jamais en base ;
 *  - si BADGE_ENCRYPTION_KEY est vide, le chiffrement est désactivé et
 *    l'authentification hors ligne devient impossible : le système le signale
 *    explicitement plutôt que d'échouer silencieusement sur le terrain ;
 *  - la valeur déchiffrée ne quitte jamais le serveur.
 */
@Injectable()
export class BadgeCipherService {
  private readonly logger = new Logger(BadgeCipherService.name);
  private readonly key: Buffer | null;

  constructor(config: ConfigService) {
    const configured = config.get<string>('BADGE_ENCRYPTION_KEY') ?? '';
    if (configured.length === 0) {
      this.key = null;
      this.logger.warn(
        "BADGE_ENCRYPTION_KEY absente : l'authentification hors ligne des badges " +
          'sera indisponible (les listes envoyées aux téléphones seront vides).',
      );
    } else {
      // Dérivation déterministe vers 32 octets : accepte une clé hexadécimale
      // comme une phrase secrète, sans imposer un format à l'exploitant.
      this.key = createHash('sha256').update(configured, 'utf8').digest();
    }
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** nonce (12 o) || chiffré || tag (16 o) */
  encrypt(plaintext: string): Buffer | null {
    if (!this.key) return null;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
  }

  decrypt(payload: Buffer | null): string | null {
    if (!this.key || !payload || payload.length < 29) return null;
    try {
      const nonce = payload.subarray(0, 12);
      const tag = payload.subarray(payload.length - 16);
      const encrypted = payload.subarray(12, payload.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf8');
    } catch (err) {
      // Une authentification GCM en échec signale une altération ou une
      // rotation de clé : jamais silencieux.
      this.logger.error(
        `Déchiffrement de badge impossible (clé changée ou donnée altérée) : ${(err as Error).message}`,
      );
      return null;
    }
  }
}
