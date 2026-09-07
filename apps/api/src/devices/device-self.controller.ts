import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { CommandsService } from './commands.service';
import { EnrollmentService } from './enrollment.service';
import { DeviceTokenService } from '../auth/device-token.service';
import {
  AuthenticatedDevice,
  CurrentDevice,
  DeviceAuth,
  Public,
} from '../auth/auth.decorators';
import {
  AppPolicyReportDto,
  CommandResultDto,
  EnrollDeviceDto,
  HeartbeatDto,
} from './dto/device.dto';
import { RefreshDto } from '../auth/dto/admin-auth.dto';

/**
 * Points d'entrée appelés par le téléphone lui-même.
 * Séparés du contrôleur d'administration : ils n'ont ni les mêmes appelants,
 * ni la même authentification, ni les mêmes contraintes de volumétrie.
 */
@ApiTags('Téléphones (appels appareil)')
@Controller('v1/devices')
export class DeviceSelfController {
  constructor(
    private readonly devices: DevicesService,
    private readonly commands: CommandsService,
    private readonly enrollment: EnrollmentService,
    private readonly deviceTokens: DeviceTokenService,
  ) {}

  @Public()
  @Post('enroll')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Enrôlement d’un téléphone à l’issue du provisioning.',
    description:
      'Route publique : l’appareil n’a encore aucune identité. Elle est ' +
      'protégée par le jeton d’enrôlement à usage unique encodé dans le QR code.',
  })
  enroll(@Body() dto: EnrollDeviceDto) {
    return this.enrollment.enroll(dto);
  }

  @Public()
  @Post('token/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotation du jeton de rafraîchissement d’un appareil.' })
  refreshToken(@Body() dto: RefreshDto) {
    return this.deviceTokens.refresh(dto.refreshToken);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post('heartbeat')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Signal de vie périodique.',
    description:
      'Met à jour last_seen_at, l’état matériel et déclenche les alertes de ' +
      'santé (batterie, localisation désactivée). Renvoie l’heure serveur, dont ' +
      'le téléphone se sert pour dater ses événements.',
  })
  heartbeat(
    @Body() dto: HeartbeatDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    if (dto.deviceId !== device.id) {
      throw new ForbiddenException(
        "L'identifiant d'appareil ne correspond pas au jeton présenté.",
      );
    }
    return this.devices.heartbeat(device.id, dto);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post('app-policy/report')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Constat de la politique d’applications appliquée.',
    description:
      'Le téléphone rapporte ce qu’il a **réellement** masqué, et ce qu’il a ' +
      'refusé de masquer. Le tableau de bord affiche ce constat, jamais la ' +
      'politique demandée : sans Device Owner, aucune application n’est masquée, ' +
      'et l’afficher comme bloquée serait mentir sur l’état du parc (§67).',
  })
  reportAppPolicy(
    @Body() dto: AppPolicyReportDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    if (dto.deviceId !== device.id) {
      throw new ForbiddenException(
        "L'identifiant d'appareil ne correspond pas au jeton présenté.",
      );
    }
    return this.devices.reportAppPolicy(device.id, dto);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Get('commands')
  @ApiOperation({ summary: 'Commandes en attente pour cet appareil.' })
  pullCommands(@CurrentDevice() device: AuthenticatedDevice) {
    return this.commands.pullPending(device.id);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post('commands/:id/result')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Acquittement d’exécution d’une commande.',
    description:
      'Idempotent : un acquittement rejoué après une réponse perdue est sans effet.',
  })
  async reportResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CommandResultDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ) {
    await this.commands.reportResult(device.id, id, dto.status, dto.error);
  }
}
