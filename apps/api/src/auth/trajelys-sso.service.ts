import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Vérification des jetons émis par Trajelys (Supabase Auth).
 *
 * ── Pourquoi une vérification locale ────────────────────────────────────
 * Trajelys signe ses jetons en ES256 et publie la clé publique sur un JWKS.
 * On les vérifie donc ici, sans appeler Supabase : pas de secret partagé
 * entre les deux produits, et aucun aller-retour réseau sur le chemin
 * d'authentification. Le jeu de clés est mis en cache par `jose` et se
 * renouvelle seul à la rotation.
 *
 * ── Ce qui est vérifié, et pourquoi chaque contrôle compte ──────────────
 *  - **l'algorithme est épinglé à ES256**. Sans cela, un jeton signé en HS256
 *    avec une clé publiquement connue — la clé anonyme de Supabase en est une
 *    — serait accepté ;
 *  - **l'émetteur** doit être le projet Supabase de Trajelys, et pas un autre
 *    projet Supabase dans le monde ;
 *  - **`role` doit valoir `authenticated`**. La clé anonyme et la clé de
 *    service sont elles aussi des jetons de ce projet : ce contrôle les
 *    écarte, en plus de l'épinglage d'algorithme ;
 *  - **`sub` doit exister**. C'est l'identifiant du compte, et c'est lui seul
 *    qui relie à une entreprise.
 *
 * Aucun de ces contrôles n'est redondant au sens où l'un rattraperait
 * l'absence d'un autre : ils écartent des jetons différents.
 */

export interface IdentiteTrajelys {
  /** `sub` du jeton : identifiant du compte côté Trajelys. */
  userId: string;
  email?: string;
}

@Injectable()
export class TrajelysSsoService {
  private readonly logger = new Logger(TrajelysSsoService.name);
  private readonly urlSupabase: string | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(config: ConfigService) {
    this.urlSupabase = config.get<string>('TRAJELYS_SUPABASE_URL')?.replace(/\/+$/, '');
    if (!this.urlSupabase) {
      // Pas une erreur : une installation qui ne vend pas le module n'a aucune
      // raison de configurer Trajelys. L'échange répondra simplement qu'il
      // n'est pas disponible.
      this.logger.log(
        "TRAJELYS_SUPABASE_URL absente : l'authentification unique Trajelys est désactivée.",
      );
    }
  }

  get actif(): boolean {
    return Boolean(this.urlSupabase);
  }

  private jeuDeCles() {
    if (!this.urlSupabase) {
      throw new UnauthorizedException("L'authentification Trajelys n'est pas configurée.");
    }
    // Créé à la première utilisation : `createRemoteJWKSet` déclenche un appel
    // réseau différé, qu'on ne veut pas au démarrage d'un service qui doit
    // pouvoir démarrer hors ligne.
    this.jwks ??= createRemoteJWKSet(
      new URL(`${this.urlSupabase}/auth/v1/.well-known/jwks.json`),
    );
    return this.jwks;
  }

  async verifier(jeton: string): Promise<IdentiteTrajelys> {
    let charge: JWTPayload;
    try {
      const { payload } = await jwtVerify(jeton, this.jeuDeCles(), {
        issuer: `${this.urlSupabase}/auth/v1`,
        algorithms: ['ES256'],
      });
      charge = payload;
    } catch (e) {
      // Le détail reste dans les journaux : renvoyé à l'appelant, il aiderait
      // à forger un jeton valide essai après essai.
      this.logger.warn(`Jeton Trajelys rejeté : ${(e as Error).message}`);
      throw new UnauthorizedException('Jeton Trajelys invalide ou expiré.');
    }

    if (charge.role !== 'authenticated') {
      throw new UnauthorizedException(
        "Ce jeton n'est pas celui d'un utilisateur connecté.",
      );
    }
    if (typeof charge.sub !== 'string' || charge.sub.length === 0) {
      throw new UnauthorizedException('Jeton Trajelys sans identifiant de compte.');
    }

    return {
      userId: charge.sub,
      email: typeof charge.email === 'string' ? charge.email : undefined,
    };
  }
}
