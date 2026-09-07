import { Module } from '@nestjs/common';
import { DepotsService } from './depots.service';
import { DepotsController } from './depots.controller';

@Module({
  controllers: [DepotsController],
  providers: [DepotsService],
  exports: [DepotsService],
})
export class DepotsModule {}
