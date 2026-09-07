import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ScreenShareService } from './screen-share.service';
import { ScreenShareController } from './screen-share.controller';
import { ScreenShareDeviceController } from './screen-share-device.controller';

@Module({
  imports: [DevicesModule, AuditModule, RealtimeModule],
  controllers: [ScreenShareController, ScreenShareDeviceController],
  providers: [ScreenShareService],
  exports: [ScreenShareService],
})
export class ScreenShareModule {}
