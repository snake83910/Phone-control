import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

export interface RateLimitDecision {
  allowed: boolean;
  /** Nombre d'occurrences dans la fenêtre courante. */
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Limitation de débit adossée à Redis, dédiée aux points sensibles
 * (scan de badge, connexion administrateur). Voir docs/07-securite.md §4.
 *
 * Elle est distincte de @nestjs/throttler, qui protège globalement l'API :
 * ici les compteurs sont sémantiques (par appareil, par empreinte de badge) et
 * doivent survivre au redémarrage d'une instance.
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async consume(
    namespace: string,
    identifier: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const key = `rl:${namespace}:${identifier}`;
    try {
      const count = await this.redis.incrementWithTtl(key, windowSeconds);
      const ttl = await this.redis.ttl(key);
      return {
        allowed: count <= limit,
        count,
        limit,
        retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
      };
    } catch (err) {
      // Redis indisponible : on laisse passer plutôt que de bloquer toute la
      // flotte, mais on trace. Un verrouillage massif de téléphones à cause
      // d'un cache injoignable serait un incident plus grave que l'absence
      // temporaire de limitation.
      this.logger.error(
        `Limitation de débit indisponible (${namespace}) : ${(err as Error).message}`,
      );
      return { allowed: true, count: 0, limit, retryAfterSeconds: 0 };
    }
  }

  /** Compteur d'échecs consécutifs, servant au verrouillage temporaire. */
  async recordFailure(
    namespace: string,
    identifier: string,
    windowSeconds: number,
  ): Promise<number> {
    try {
      return await this.redis.incrementWithTtl(
        `fail:${namespace}:${identifier}`,
        windowSeconds,
      );
    } catch {
      return 0;
    }
  }

  async clearFailures(namespace: string, identifier: string): Promise<void> {
    await this.redis.del(`fail:${namespace}:${identifier}`).catch(() => undefined);
  }

  async isLockedOut(namespace: string, identifier: string): Promise<boolean> {
    const value = await this.redis
      .get(`lock:${namespace}:${identifier}`)
      .catch(() => null);
    return value !== null;
  }

  async lockOut(
    namespace: string,
    identifier: string,
    minutes: number,
  ): Promise<void> {
    await this.redis
      .setWithTtl(`lock:${namespace}:${identifier}`, '1', minutes * 60)
      .catch(() => undefined);
  }

  /** Paramètres du scan de badge, lus une fois depuis la configuration. */
  get barcodeLimits() {
    return {
      perDevicePerMinute: this.config.get<number>(
        'BARCODE_THROTTLE_PER_DEVICE_PER_MIN',
      )!,
      perBadgePerMinute: this.config.get<number>(
        'BARCODE_THROTTLE_PER_BADGE_PER_MIN',
      )!,
      lockoutFailures: this.config.get<number>(
        'BARCODE_DEVICE_LOCKOUT_FAILURES',
      )!,
      lockoutMinutes: this.config.get<number>('BARCODE_DEVICE_LOCKOUT_MINUTES')!,
    };
  }
}
