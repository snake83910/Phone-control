import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/**
 * Notifications sortantes.
 *
 * Global parce que le moteur d'alertes en dépend, et que les alertes sont
 * levées depuis à peu près partout — synchronisation, tâches planifiées,
 * authentification par badge.
 */
@Global()
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
