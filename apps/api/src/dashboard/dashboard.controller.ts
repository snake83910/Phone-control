import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { AuthenticatedAdmin, CurrentAdmin } from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';

export class ActivityQueryDto {
  @ApiPropertyOptional({ default: 7, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

@ApiTags('Tableau de bord')
@ApiBearerAuth('admin')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Indicateurs de la page d’accueil.' })
  summary(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.dashboard.summary(requireCompany(admin));
  }

  @Get('activity')
  @ApiOperation({ summary: 'Sessions et alertes par jour.' })
  activity(
    @Query() query: ActivityQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.dashboard.activity(requireCompany(admin), query.days ?? 7);
  }
}
