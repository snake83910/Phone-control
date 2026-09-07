import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, ServerOptions } from 'socket.io';
import Redis from 'ioredis';

/**
 * Adaptateur Socket.IO adossé à Redis.
 *
 * Sans lui, une diffusion n'atteint que les navigateurs connectés à l'instance
 * qui l'émet. Avec deux répliques d'API derrière un proxy, la moitié des
 * administrateurs manquerait la moitié des alertes — panne difficile à
 * diagnostiquer, car tout fonctionne parfaitement en développement sur une
 * seule instance.
 *
 * Si Redis est injoignable, l'application démarre quand même en mode local :
 * un flux temps réel dégradé vaut mieux qu'une API qui refuse de démarrer.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    try {
      const pubClient = new Redis(this.redisUrl, { lazyConnect: true });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log('Adaptateur Socket.IO Redis actif');
    } catch (err) {
      this.logger.warn(
        `Adaptateur Redis indisponible (${(err as Error).message}) : ` +
          'le temps réel fonctionnera en mode instance unique.',
      );
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
