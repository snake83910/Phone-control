import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { AuditModule } from '../audit/audit.module';
import { AppPackagesService } from './app-packages.service';
import { AppPackagesController } from './app-packages.controller';
import { ApkUploadSupport } from './apk-upload';

@Module({
  imports: [DevicesModule, AuditModule],
  controllers: [AppPackagesController],
  providers: [AppPackagesService, ApkUploadSupport],
  exports: [AppPackagesService],
})
export class AppPackagesModule {}
