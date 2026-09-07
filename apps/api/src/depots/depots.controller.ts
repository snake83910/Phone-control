import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { DepotsService } from './depots.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';
import { CreateDepotDto, UpdateDepotDto } from './dto/depot.dto';

@ApiTags('Dépôts')
@ApiBearerAuth('admin')
@Controller('v1/depots')
export class DepotsController {
  constructor(
    private readonly depots: DepotsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des dépôts.' })
  list() {
    return this.depots.findAll();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Détail d’un dépôt, avec les règles horaires résolues du jour.',
  })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.depots.findOne(id);
  }

  @Post()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({ summary: 'Crée un dépôt et son geofence.' })
  async create(
    @Body() dto: CreateDepotDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const depot = await this.depots.create(requireCompany(admin), dto);
    await this.audit.record({
      action: 'ADMIN_CREATE_DEPOT',
      resourceType: 'depot',
      resourceId: depot.id,
      after: { code: depot.code, name: depot.name },
    });
    return depot;
  }

  @Patch(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({
    summary: 'Modifie un dépôt (horaires, position, rayon, fuseau).',
    description:
      'Toute modification de géométrie est propagée au geofence, sans quoi la ' +
      'correction resterait sans effet sur les téléphones.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepotDto,
  ) {
    const before = await this.depots.findOne(id);
    const depot = await this.depots.update(id, dto);
    await this.audit.record({
      action: 'ADMIN_CHANGE_DEPOT',
      resourceType: 'depot',
      resourceId: id,
      before: {
        returnTime: before.returnTime,
        lockTime: before.lockTime,
        radiusMeters: before.radiusMeters,
        timezone: before.timezone,
      },
      after: dto,
    });
    return depot;
  }
}
