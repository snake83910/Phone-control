import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AlertsModule } from '../alerts/alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { DevicesService } from './devices.service';
import { CommandsService } from './commands.service';
import { EnrollmentService } from './enrollment.service';
import { DevicesController } from './devices.controller';
import { DeviceSelfController } from './device-self.controller';

@Module({
  imports: [AuthModule, AlertsModule, SettingsModule],
  controllers: [DevicesController, DeviceSelfController],
  providers: [DevicesService, CommandsService, EnrollmentService],
  exports: [DevicesService, CommandsService, EnrollmentService],
})
export class DevicesModule {}
