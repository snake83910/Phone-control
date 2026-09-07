import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncService } from './sync.service';
import { SyncEventsDto, SyncPullQueryDto } from './dto/sync.dto';
import {
  AuthenticatedDevice,
  CurrentDevice,
  DeviceAuth,
} from '../auth/auth.decorators';

@ApiTags('Synchronisation')
@ApiBearerAuth('device')
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @DeviceAuth()
  @Post('events')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remontée d’un lot d’événements accumulés par le téléphone.',
    description:
      'Idempotent : chaque événement porte un event_id généré par l’appareil. ' +
      'Un lot renvoyé après un délai d’attente ne crée aucun doublon. La réponse ' +
      'liste les événements acquittés, seuls ceux-là peuvent être purgés localement.',
  })
  push(
    @Body() dto: SyncEventsDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    if (dto.deviceId !== device.id) {
      throw new ForbiddenException(
        "L'identifiant d'appareil ne correspond pas au jeton présenté.",
      );
    }
    return this.sync.push(device.id, dto.events);
  }

  @DeviceAuth()
  @Get('pull')
  @ApiOperation({
    summary: 'Configuration, listes hors ligne, commandes et état de session.',
    description:
      'La configuration n’est renvoyée que si sa version a changé. La liste ' +
      'hors ligne ne contient jamais de numéro de badge, mais des empreintes ' +
      'que seul cet appareil peut recalculer.',
  })
  pull(
    @Query() query: SyncPullQueryDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    return this.sync.pull(device.id, query.configVersion);
  }
}
