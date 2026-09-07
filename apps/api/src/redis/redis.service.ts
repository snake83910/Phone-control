import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableOfflineQueue: true,
    });
    this.client.on('error', (err) =>
      this.logger.error(`Redis: ${err.message}`),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Connexion Redis établie');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  /**
   * Incrémente un compteur à fenêtre glissante et renvoie sa valeur.
   * INCR + EXPIRE dans un pipeline : la fenêtre démarre à la première occurrence.
   */
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const [[, count]] = (await this.client
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .exec()) as [[Error | null, number], unknown];
    return count;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }
}
