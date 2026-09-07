import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';
import { UsersService } from './users.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';
import {
  AssignDeviceDto,
  CreateUserDto,
  UpdateUserStatusDto,
} from './dto/user.dto';
import { UserListQueryDto } from '../common/dto/query.dto';

@ApiTags('Chauffeurs')
@ApiBearerAuth('admin')
@Controller('v1/users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des chauffeurs.' })
  list(@Query() query: UserListQueryDto) {
    return this.users.findAll({
      status: query.status,
      depotId: query.depotId,
      search: query.search,
      take: query.take ?? 50,
      skip: query.skip ?? 0,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fiche chauffeur : badges masqués, téléphones autorisés.' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.findOne(id);
  }

  @Post()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({ summary: 'Crée un chauffeur.' })
  async create(
    @Body() dto: CreateUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const user = await this.users.create({ companyId: requireCompany(admin), ...dto });
    await this.audit.record({
      action: 'ADMIN_CREATE_USER',
      resourceType: 'user',
      resourceId: user.id,
      after: { firstName: user.firstName, lastName: user.lastName },
    });
    return user;
  }

  @Post(':id/status')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({ summary: 'Active ou désactive un chauffeur.' })
  async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    const user = await this.users.setStatus(id, dto.status);
    await this.audit.record({
      action: 'ADMIN_DISABLE_USER',
      resourceType: 'user',
      resourceId: id,
      after: { status: dto.status },
    });
    return user;
  }

  @Post(':id/devices')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({
    summary: 'Autorise un chauffeur à utiliser un téléphone.',
    description:
      'Sans cette affectation, le scan du badge sur ce téléphone est refusé ' +
      'avec « Ce téléphone n’est pas autorisé pour cet utilisateur ».',
  })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDeviceDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const assignment = await this.users.assignDevice(
      requireCompany(admin),
      id,
      dto.deviceId,
      admin.id,
    );
    await this.audit.record({
      action: 'ADMIN_ASSIGN_DEVICE',
      resourceType: 'user',
      resourceId: id,
      after: { deviceId: dto.deviceId },
    });
    return assignment;
  }

  @Delete(':id/devices/:deviceId')
  @HttpCode(204)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({ summary: 'Retire l’autorisation d’un téléphone.' })
  async unassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ) {
    await this.users.unassignDevice(id, deviceId);
    await this.audit.record({
      action: 'ADMIN_UNASSIGN_DEVICE',
      resourceType: 'user',
      resourceId: id,
      after: { deviceId },
    });
  }

  @Post(':id/anonymize')
  @HttpCode(204)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({
    summary: 'Anonymisation RGPD.',
    description:
      'Efface l’identité, révoque les badges et clôt les affectations. ' +
      'Les événements sont conservés, mais ne désignent plus une personne.',
  })
  async anonymize(@Param('id', ParseUUIDPipe) id: string) {
    await this.users.anonymize(id);
    await this.audit.record({
      action: 'ADMIN_ANONYMIZE_USER',
      resourceType: 'user',
      resourceId: id,
    });
  }
}
