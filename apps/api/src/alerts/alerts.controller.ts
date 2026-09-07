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
import { Prisma } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AlertsService } from './alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedAdmin, CurrentAdmin } from '../auth/auth.decorators';
import { AlertListQueryDto } from '../common/dto/query.dto';

export class ResolveAlertDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  note?: string;
}

@ApiTags('Alertes')
@ApiBearerAuth('admin')
@Controller('v1/alerts')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Alertes, les plus récentes d’abord.' })
  async list(@Query() query: AlertListQueryDto) {
    const where: Prisma.AlertWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.alert.findMany({
        where,
        take: query.take ?? 50,
        skip: query.skip ?? 0,
        orderBy: { createdAt: 'desc' },
        include: {
          device: { select: { id: true, assetTag: true } },
          user: { select: { id: true, firstName: true, lastName: true } },
          depot: { select: { id: true, name: true } },
        },
      }),
      this.prisma.db.alert.count({ where }),
    ]);
    return { items, total, take: query.take ?? 50, skip: query.skip ?? 0 };
  }

  @Post(':id/acknowledge')
  @ApiOperation({ summary: 'Acquitte une alerte.' })
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const alert = await this.alerts.acknowledge(id, admin.id);
    await this.audit.record({
      action: 'ADMIN_ACKNOWLEDGE_ALERT',
      resourceType: 'alert',
      resourceId: id,
    });
    return alert;
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Clôture une alerte.' })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveAlertDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const alert = await this.alerts.resolve(id, admin.id, dto.note);
    await this.audit.record({
      action: 'ADMIN_RESOLVE_ALERT',
      resourceType: 'alert',
      resourceId: id,
      after: { note: dto.note ?? null },
    });
    return alert;
  }
}
