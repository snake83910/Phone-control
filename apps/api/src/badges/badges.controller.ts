import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole, BadgeStatus } from '@prisma/client';
import { BadgesService } from './badges.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';
import {
  CreateBadgeDto,
  ReassignBadgeDto,
  UpdateBadgeStatusDto,
} from './dto/badge.dto';
import { BadgeListQueryDto } from '../common/dto/query.dto';

@ApiTags('Badges')
@ApiBearerAuth('admin')
@Controller('v1/badges')
export class BadgesController {
  constructor(
    private readonly badges: BadgesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des badges (numéros masqués).' })
  list(@Query() query: BadgeListQueryDto) {
    return this.badges.findAll({
      userId: query.userId,
      status: query.status,
      take: query.take ?? 50,
      skip: query.skip ?? 0,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’un badge.' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.badges.findOne(id);
  }

  @Post()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({ summary: 'Enregistre un badge existant pour un chauffeur.' })
  async create(
    @Body() dto: CreateBadgeDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const badge = await this.badges.create({
      companyId: requireCompany(admin),
      userId: dto.userId,
      rawBarcode: dto.barcode,
      barcodeType: dto.barcodeType,
    });
    await this.audit.record({
      action: 'ADMIN_CREATE_BADGE',
      resourceType: 'badge',
      resourceId: badge.id,
      // Le journal d'audit ne contient jamais le numéro complet.
      after: { userId: dto.userId, maskedBarcode: badge.maskedBarcode },
    });
    return badge;
  }

  @Post(':id/status')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({ summary: 'Active, désactive ou révoque un badge.' })
  async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBadgeStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const before = await this.badges.findOne(id);
    const badge = await this.badges.setStatus(id, dto.status, dto.reason, admin.id);
    await this.audit.record({
      action:
        dto.status === BadgeStatus.REVOKED
          ? 'ADMIN_REVOKE_BADGE'
          : 'ADMIN_UPDATE_BADGE_STATUS',
      resourceType: 'badge',
      resourceId: id,
      before: { status: before.status },
      after: { status: badge.status, reason: dto.reason ?? null },
    });
    return badge;
  }

  @Post(':id/reassign')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({ summary: 'Réaffecte un badge à un autre chauffeur.' })
  async reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReassignBadgeDto,
  ) {
    const before = await this.badges.findOne(id);
    const badge = await this.badges.reassign(id, dto.userId);
    await this.audit.record({
      action: 'ADMIN_REASSIGN_BADGE',
      resourceType: 'badge',
      resourceId: id,
      before: { userId: before.userId },
      after: { userId: dto.userId },
    });
    return badge;
  }
}
