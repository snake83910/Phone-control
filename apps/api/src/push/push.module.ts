import { Global, Module } from '@nestjs/common';
import { PushService } from './push.service';

/**
 * Réveil des téléphones.
 *
 * Global : les commandes sont créées depuis le dashboard, la synchronisation et
 * les tâches planifiées, et toutes veulent que le téléphone les voie vite.
 */
@Global()
@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
