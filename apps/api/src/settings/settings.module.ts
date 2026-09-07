import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AppPolicyController } from './app-policy.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [AppPolicyController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
