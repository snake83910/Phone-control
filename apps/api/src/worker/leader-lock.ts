import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * Verrou d'exécution unique, adossé à Redis.
 *
 * Les tâches planifiées scrutent l'ensemble de la flotte. Si deux répliques de
 * l'API les exécutent en même temps, chaque téléphone reçoit deux ordres de
 * verrouillage et chaque incident produit deux alertes. Le verrou garantit
 * qu'une seule instance travaille, et il expire seul : une instance qui meurt
 * en cours de tâche ne bloque pas les suivantes.
 */
@Injectable()
export class LeaderLock {
  private readonly logger = new Logger(LeaderLock.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Exécute `fn` si le verrou est obtenu, sinon ne fait rien.
   * Le TTL doit dépasser la durée d'exécution attendue, sans être si long
   * qu'une instance disparue paralyserait la tâche pendant des heures.
   */
  async run(
    name: string,
    ttlSeconds: number,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    const key = `lock:job:${name}`;
    let acquired = false;

    try {
      const result = await this.redis.client.set(
        key,
        String(process.pid),
        'EX',
        ttlSeconds,
        'NX',
      );
      acquired = result === 'OK';
    } catch (err) {
      // Redis injoignable : on exécute quand même. Sur un déploiement à une
      // seule instance — le cas courant — refuser d'agir serait pire que le
      // risque théorique de double exécution.
      this.logger.warn(
        `Verrou ${name} indisponible (${(err as Error).message}) : exécution sans verrou.`,
      );
      acquired = true;
    }

    if (!acquired) return false;

    try {
      await fn();
    } finally {
      // Le verrou n'est pas relâché : sa durée de vie sert d'intervalle minimal
      // entre deux exécutions, ce qui protège aussi d'un déclenchement en
      // rafale après un redémarrage.
      void 0;
    }

    return true;
  }
}
