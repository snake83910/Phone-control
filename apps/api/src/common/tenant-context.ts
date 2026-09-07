import { AsyncLocalStorage } from 'node:async_hooks';
import { AdminRole } from '@prisma/client';

/**
 * Contexte de la requête courante, propagé sans passage de paramètre grâce à
 * AsyncLocalStorage. C'est la source de vérité du cloisonnement multi-entreprises :
 * l'extension Prisma s'en sert pour injecter automatiquement le filtre company_id.
 */
export interface RequestContext {
  correlationId: string;
  /** Entreprise active. NULL uniquement pour un SUPER_ADMIN non restreint. */
  companyId: string | null;
  adminId?: string;
  deviceId?: string;
  role?: AdminRole;
  /** Restriction facultative à un sous-ensemble de dépôts. */
  depotScope?: string[];
  ip?: string;
  userAgent?: string;
  /**
   * Autorise explicitement une requête à traverser les entreprises.
   * Réservé au SUPER_ADMIN et aux tâches de fond ; jamais activé par défaut.
   */
  crossTenant?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const TenantContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /** Contexte courant, ou erreur : utilisé là où l'absence est un bug. */
  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new Error(
        "Aucun contexte de requête actif. Toute opération sur des données d'entreprise " +
          'doit être exécutée dans TenantContext.run().',
      );
    }
    return ctx;
  },

  /** Contexte des tâches de fond : traverse les entreprises, sans administrateur. */
  system<T>(fn: () => T, correlationId = 'system'): T {
    return storage.run(
      { correlationId, companyId: null, crossTenant: true },
      fn,
    );
  },
};
