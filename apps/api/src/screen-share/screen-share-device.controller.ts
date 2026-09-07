import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ScreenShareService } from './screen-share.service';
import {
  AuthenticatedDevice,
  CurrentDevice,
  DeviceAuth,
} from '../auth/auth.decorators';

export class ScreenShareConsentDto {
  @ApiProperty({
    description:
      'Réponse du chauffeur. C’est le seul chemin par lequel un partage peut ' +
      's’ouvrir : aucun administrateur ne peut accorder cet accord à sa place.',
  })
  @IsBoolean()
  accepted!: boolean;

  @ApiPropertyOptional({
    description: 'Précision facultative, rapportée telle quelle.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;
}

export class ScreenShareFrameDto {
  @ApiProperty({
    description:
      'Capture JPEG encodée en base64. Elle est relayée puis oubliée : le ' +
      'serveur ne l’écrit nulle part.',
  })
  @IsString()
  image!: string;

  @ApiProperty({ example: 540 })
  @IsInt()
  @Min(1)
  @Max(8000)
  width!: number;

  @ApiProperty({ example: 1140 })
  @IsInt()
  @Min(1)
  @Max(8000)
  height!: number;

  @ApiPropertyOptional({ description: 'Horodatage de la capture sur le téléphone.' })
  @IsOptional()
  @IsISO8601()
  capturedAt?: string;
}

export class ScreenShareStopDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;
}

/**
 * Partage d'ecran, cote telephone.
 *
 * Toutes ces routes sont authentifiees par le jeton de l'appareil, et chacune
 * verifie que la seance visee appartient bien a CET appareil. Un telephone ne
 * peut ni consentir, ni envoyer d'image, ni couper le partage d'un autre.
 */
@ApiTags('Partage d’écran (appels appareil)')
@Controller('v1/devices/screen-share')
export class ScreenShareDeviceController {
  constructor(private readonly screenShare: ScreenShareService) {}

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Get('current')
  @ApiOperation({
    summary: 'Demande en attente ou partage en cours pour ce téléphone.',
    description:
      'Interrogée au démarrage : une demande peut avoir été émise pendant que ' +
      'le téléphone était hors réseau, et la commande peut s’être perdue. ' +
      'Renvoie null quand il n’y a rien — y compris quand la demande a expiré.',
  })
  current(@CurrentDevice() device: AuthenticatedDevice) {
    return this.screenShare.currentForDevice(device.id);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Get(':id')
  @ApiOperation({ summary: 'État d’une séance, vu du téléphone.' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    return this.screenShare.forDevice(device.id, id);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post(':id/consent')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Réponse du chauffeur à une demande de partage.',
    description:
      'Un accord ne vaut que pour une demande en attente : répondre à une ' +
      'demande expirée est refusé, plutôt que d’ouvrir un partage sur une ' +
      'question que plus personne ne pose.',
  })
  consent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScreenShareConsentDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    return this.screenShare.recordConsent(
      device.id,
      id,
      dto.accepted,
      dto.detail,
    );
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post(':id/frame')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Envoi d’une capture.',
    description:
      'Refusée par 403 hors de l’état accepté, ou une fois la durée maximale ' +
      'atteinte : le téléphone doit alors arrêter, pas réessayer.',
  })
  frame(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScreenShareFrameDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    return this.screenShare.relayFrame({
      deviceId: device.id,
      sessionId: id,
      image: dto.image,
      width: dto.width,
      height: dto.height,
      capturedAt: dto.capturedAt,
    });
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Le chauffeur coupe le partage.',
    description:
      'Toujours disponible pendant un partage. C’est la garantie qui rend ' +
      'l’accord révocable : un consentement qu’on ne peut pas retirer n’en est ' +
      'plus un.',
  })
  stop(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScreenShareStopDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    return this.screenShare.end({
      sessionId: id,
      event: 'DRIVER_STOPS',
      deviceId: device.id,
      detail: dto.detail,
    });
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post(':id/failed')
  @HttpCode(200)
  @ApiOperation({
    summary: 'La capture n’a pas pu démarrer.',
    description:
      'Android a refusé, ou le service de capture n’a pas pu se lancer. ' +
      'L’administrateur doit voir un échec explicite, et non un écran qui reste ' +
      'vide sans explication (§67).',
  })
  failed(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScreenShareStopDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    return this.screenShare.end({
      sessionId: id,
      event: 'CAPTURE_FAILED',
      deviceId: device.id,
      detail: dto.detail,
    });
  }
}
