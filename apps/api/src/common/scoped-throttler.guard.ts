import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Limitation de débit par identité, et non par adresse IP.
 *
 * **Défaut trouvé au banc de charge.** Le compteur par défaut de
 * `@nestjs/throttler` est l'adresse IP. Sur le terrain, quelques centaines de
 * téléphones partagent l'adresse publique de leur opérateur mobile — c'est le
 * fonctionnement normal du NAT d'opérateur. Le parc épuisait alors un seul
 * quota de cent vingt requêtes par minute, et recevait des 429 sur ses
 * heartbeats et ses synchronisations. Le banc de charge l'a reproduit en
 * quelques secondes ; sur le terrain, cela se serait manifesté par des
 * téléphones « qui ne remontent plus », de façon intermittente et incompréhensible.
 *
 * Une requête authentifiée est donc comptée sur **le porteur du jeton** : chaque
 * téléphone, chaque administrateur a son propre quota. Les requêtes anonymes —
 * connexion, enrôlement — restent comptées par adresse IP, car c'est là que la
 * limitation protège vraiment : elle empêche une attaque par force brute de
 * faire travailler Argon2 des milliers de fois.
 *
 * **Le sujet du jeton est lu sans vérifier la signature.** C'est assumé : la
 * vérification a lieu juste après, dans le garde d'authentification, et un
 * attaquant qui forgerait un sujet ne gagnerait qu'un compteur distinct — il
 * n'obtiendrait ni accès ni traitement coûteux. Vérifier la signature ici
 * reviendrait à faire le travail deux fois, et à faire précéder la limitation
 * de débit par ce qu'elle est censée protéger.
 */
@Injectable()
export class ScopedThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(request: Record<string, unknown>): Promise<string> {
    const subject = subjectOfBearerToken(
      (request.headers as Record<string, string | undefined> | undefined)?.authorization,
    );

    if (subject) return `sub:${subject}`;

    const ip = typeof request.ip === 'string' ? request.ip : 'inconnue';
    return `ip:${ip}`;
  }
}

/**
 * Sujet d'un JWT, sans vérification de signature.
 *
 * Retourne `undefined` à la moindre anomalie : un en-tête absent, un jeton
 * malformé, un corps illisible. L'appelant retombe alors sur l'adresse IP, ce
 * qui est le comportement sûr.
 */
export function subjectOfBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;

  const parts = authorization.slice('Bearer '.length).trim().split('.');
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sub?: unknown;
      typ?: unknown;
    };
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return undefined;

    // Le type est joint au sujet : un identifiant d'appareil et un identifiant
    // d'administrateur pourraient théoriquement coïncider, et partager alors un
    // compteur sans raison.
    const kind = typeof payload.typ === 'string' ? payload.typ : 'jwt';
    return `${kind}:${payload.sub}`;
  } catch {
    return undefined;
  }
}
