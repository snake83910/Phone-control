import { Module } from '@nestjs/common';
import { TrajelysIntegrationController } from './trajelys-integration.controller';
import { TrajelysIntegrationService } from './trajelys-integration.service';

@Module({
  controllers: [TrajelysIntegrationController],
  providers: [TrajelysIntegrationService],
})
export class TrajelysIntegrationModule {}
