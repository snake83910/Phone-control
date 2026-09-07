import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  BarcodeScanResult,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto } from '../common/dto/query.dto';

export class SecurityQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SecurityEventType })
  @IsOptional()
  @IsEnum(SecurityEventType)
  type?: SecurityEventType;

  @ApiPropertyOptional({ enum: SecuritySeverity })
  @IsOptional()
  @IsEnum(SecuritySeverity)
  severity?: SecuritySeverity;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class ScanQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: BarcodeScanResult })
  @IsOptional()
  @IsEnum(BarcodeScanResult)
  result?: BarcodeScanResult;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ default: 7, maximum: 90, description: 'Profondeur en jours.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

@ApiTags('Sécurité')
@ApiBearerAuth('admin')
@Controller('v1/security')
export class SecurityController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('events')
  @ApiOperation({ summary: 'Historique de sécurité.' })
  async events(@Query() query: SecurityQueryDto) {
    const where: Prisma.SecurityEventWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const take = query.take ?? 50;
    const skip = query.skip ?? 0;

    const [items, total] = await Promise.all([
      this.prisma.db.securityEvent.findMany({
        where,
        take,
        skip,
        orderBy: { occurredAt: 'desc' },
        include: {
          device: { select: { id: true, assetTag: true } },
          user: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.db.securityEvent.count({ where }),
    ]);

    return { items, total, take, skip };
  }

  @Get('scans')
  @ApiOperation({
    summary: 'Historique des scans de badge.',
    description:
      'Les numéros ne sont jamais exposés : seuls les quatre derniers caractères ' +
      'apparaissent, y compris pour les badges inconnus.',
  })
  async scans(@Query() query: ScanQueryDto) {
    const since = new Date(Date.now() - (query.days ?? 7) * 86_400_000);
    const where: Prisma.BarcodeScanEventWhereInput = {
      scannedAt: { gte: since },
      ...(query.result ? { result: query.result } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const take = query.take ?? 50;
    const skip = query.skip ?? 0;

    const [rows, total] = await Promise.all([
      this.prisma.db.barcodeScanEvent.findMany({
        where,
        take,
        skip,
        orderBy: { scannedAt: 'desc' },
        include: {
          device: { select: { id: true, assetTag: true } },
          user: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.db.barcodeScanEvent.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        result: r.result,
        scannedAt: r.scannedAt,
        offline: r.offline,
        device: r.device,
        user: r.user,
        // Ni la valeur, ni l'empreinte : le dashboard n'a besoin d'aucune des
        // deux pour faire son travail.
        barcodeLast4: r.barcodeLast4,
      })),
      total,
      take,
      skip,
    };
  }
}
