import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole, CommandType, KioskMode } from '@prisma/client';
import { DevicesService } from './devices.service';
import { CommandsService } from './commands.service';
import { EnrollmentService } from './enrollment.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';
import { CreateCommandDto, CreateDeviceDto } from './dto/device.dto';
import { DeviceListQueryDto } from '../common/dto/query.dto';

@ApiTags('Téléphones')
@ApiBearerAuth('admin')
@Controller('v1/devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly commands: CommandsService,
    private readonly enrollment: EnrollmentService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des téléphones de l’entreprise active.' })
  list(@Query() query: DeviceListQueryDto) {
    return this.devices.findAll({
      depotId: query.depotId,
      state: query.state,
      take: query.take ?? 50,
      skip: query.skip ?? 0,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fiche complète d’un téléphone.' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.devices.findOne(id);
  }

  @Post()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({ summary: 'Déclare un téléphone avant son provisioning.' })
  async create(
    @Body() dto: CreateDeviceDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const device = await this.devices.create(
      requireCompany(admin),
      dto.assetTag,
      dto.depotId,
      dto.kioskMode as never,
    );
    await this.audit.record({
      action: 'ADMIN_CREATE_DEVICE',
      resourceType: 'device',
      resourceId: device.id,
      after: { assetTag: device.assetTag, depotId: device.depotId },
    });
    return device;
  }

  @Post(':id/enrollment-token')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({
    summary: 'Génère le jeton d’enrôlement à encoder dans le QR de provisioning.',
    description:
      'Le jeton est à usage unique et expire. Il n’est renvoyé en clair qu’ici : ' +
      'la base n’en conserve que l’empreinte.',
  })
  async createEnrollmentToken(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const device = await this.devices.findOne(id);
    const token = await this.enrollment.createToken({
      companyId: requireCompany(admin),
      depotId: device.depot?.id ?? null,
      assetTag: device.assetTag,
      deviceId: device.id,
      kioskMode: device.kioskMode as KioskMode,
      createdBy: admin.id,
    });
    await this.audit.record({
      action: 'ADMIN_CREATE_ENROLLMENT_TOKEN',
      resourceType: 'device',
      resourceId: id,
      after: { enrollmentTokenId: token.id, expiresAt: token.expiresAt },
    });
    return token;
  }

  @Post(':id/commands')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({ summary: 'Envoie une commande à un téléphone.' })
  async sendCommand(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommandDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const device = await this.devices.findOne(id);
    const command = await this.commands.enqueue({
      companyId: requireCompany(admin),
      deviceId: device.id,
      command: dto.command,
      payload: dto.payload,
      ttlMinutes: dto.ttlMinutes,
      createdBy: admin.id,
      idempotencyKey: dto.idempotencyKey ?? null,
    });
    await this.audit.record({
      action: auditActionFor(dto.command),
      resourceType: 'device',
      resourceId: id,
      after: { commandId: command.id, command: dto.command, payload: dto.payload },
    });
    return command;
  }

  @Post(':id/revoke')
  @HttpCode(204)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({
    summary: 'Révoque un téléphone : ses jetons cessent immédiatement d’être valides.',
  })
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.enrollment.revokeDevice(id);
    await this.audit.record({
      action: 'ADMIN_REVOKE_DEVICE',
      resourceType: 'device',
      resourceId: id,
    });
  }
}

function auditActionFor(command: CommandType): string {
  switch (command) {
    case CommandType.LOCK_DEVICE:
      return 'ADMIN_LOCK_DEVICE';
    case CommandType.UNLOCK_DEVICE:
      return 'ADMIN_UNLOCK_DEVICE';
    case CommandType.FORCE_LOGOUT:
      return 'ADMIN_FORCE_LOGOUT';
    case CommandType.WIPE_DEVICE:
      return 'ADMIN_WIPE_DEVICE';
    case CommandType.LOCATE_NOW:
      return 'ADMIN_LOCATE_DEVICE';
    default:
      return `ADMIN_COMMAND_${command}`;
  }
}
