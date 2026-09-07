import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * Jetons opaques (rafraîchissement, enrôlement) et mots de passe administrateurs.
 *
 * Deux algorithmes, deux usages distincts :
 *  - Argon2id pour les mots de passe : entropie faible choisie par un humain,
 *    donc il faut rendre chaque essai coûteux ;
 *  - SHA-256 pour les jetons : 256 bits d'entropie aléatoire, un hachage lent
 *    n'apporterait rien et coûterait à chaque rafraîchissement.
 */
@Injectable()
export class TokenService {
  /** Paramètres Argon2id : 64 Mio, 3 passes, parallélisme 4 (cf. docs/07 §2.1). */
  private readonly argonOptions = {
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  } as const;

  async hashPassword(plain: string): Promise<string> {
    return argonHash(plain, this.argonOptions);
  }

  async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argonVerify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Jeton opaque de 256 bits, transmis une seule fois au client. */
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Empreinte stockée en base : le jeton en clair n'est jamais persisté. */
  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url');
  }

  compareTokenHash(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /**
   * Jeton d'enrôlement lisible en atelier, encodé dans le QR de provisioning.
   * Format : ETK-XXXXXXXX-XXXXXXXX (base32 sans caractères ambigus).
   */
  generateEnrollmentToken(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++) {
      out += alphabet[bytes[i] % alphabet.length];
      if (i === 7) out += '-';
    }
    return `ETK-${out}`;
  }
}
