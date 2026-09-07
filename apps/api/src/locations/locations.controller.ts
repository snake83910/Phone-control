import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { LocationsService } from './locations.service';
import { SettingsService } from '../settings/settings.service';
import { AuthenticatedAdmin, CurrentAdmin } from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';

export class HistoryQueryDto {
  @ApiPropertyOptional({ description: 'Début de la plage (ISO 8601).' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Fin de la plage (ISO 8601).' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ default: 2000, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}

@ApiTags('Positions')
@ApiBearerAuth('admin')
@Controller('v1/locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly settings: SettingsService,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Dernière position connue de chaque téléphone, pour la carte.',
    description:
      'Lue sur les colonnes dénormalisées de `devices` : afficher la flotte ne ' +
      'déclenche aucun balayage de la table d’événements.',
  })
  async live(@CurrentAdmin() admin: AuthenticatedAdmin) {
    const settings = await this.settings.resolveForCompany(requireCompany(admin));
    return this.locations.live(settings.offlineAlertDelayMinutes);
  }

  @Get('devices/:id/history')
  @ApiOperation({
    summary: 'Trace d’un téléphone sur une plage horaire (7 jours maximum).',
    description:
      'La borne temporelle est obligatoire : la table est partitionnée par mois, ' +
      'une requête sans borne balaierait toutes les partitions.',
  })
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HistoryQueryDto,
  ) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 86_400_000);
    return this.locations.history({
      deviceId: id,
      from,
      to,
      limit: query.limit ?? 2000,
    });
  }

  @Get('sessions/:id/trail')
  @ApiOperation({ summary: 'Événements de geofence d’une session.' })
  trail(@Param('id', ParseUUIDPipe) id: string) {
    return this.locations.sessionTrail(id);
  }
}
