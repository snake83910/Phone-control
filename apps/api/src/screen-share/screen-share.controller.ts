import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AdminRole } from '@prisma/client';
import { ScreenShareService } from './screen-share.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';

export class RequestScreenShareDto {
  @ApiProperty({
    example: 'Le chauffeur ne trouve pas le bouton de fin de tournée.',
    description:
      'Motif affiché tel quel au chauffeur avant qu’il ne décide. Obligatoire : ' +
      'un accord donné sans savoir pourquoi n’est pas un accord.',
  })
  @IsString()
  @MinLength(10, {
    message:
      'Expliquez la raison de la demande en une phrase : le chauffeur la lira ' +
      'avant de répondre.',
  })
  @MaxLength(300)
  reason!: string;
}

/**
 * Partage d'ecran, cote exploitation.
 *
 * Rien ici n'ouvre un partage. Ces routes emettent une DEMANDE, suivent son
 * sort, et permettent d'y mettre fin. L'accord appartient au chauffeur, et il
 * ne se donne que depuis le telephone.
 */
@ApiTags('Partage d’écran')
@ApiBearerAuth('admin')
@Controller('v1/screen-share')
export class ScreenShareController {
  constructor(private readonly screenShare: ScreenShareService) {}

  @Post('devices/:deviceId')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({
    summary: 'Demande à voir l’écran d’un téléphone.',
    description:
      'N’ouvre aucun partage : fait apparaître une demande sur le téléphone, ' +
      'que le chauffeur accepte ou refuse. La demande expire d’elle-même si ' +
      'personne ne répond, et le partage accordé se ferme seul au bout de la ' +
      'durée configurée.',
  })
  request(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() dto: RequestScreenShareDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.screenShare.request({
      companyId: requireCompany(admin),
      deviceId,
      adminId: admin.id,
      reason: dto.reason,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'État d’une demande de partage.' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.screenShare.findOne(requireCompany(admin), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({
    summary: 'Met fin au partage, ou annule la demande.',
    description:
      'Idempotent : arrêter un partage déjà terminé ne produit ni erreur ni effet.',
  })
  stop(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.screenShare.end({
      sessionId: id,
      event: 'ADMIN_STOPS',
      companyId: requireCompany(admin),
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Historique des partages d’écran.',
    description:
      'Qui a demandé à voir quel écran, pourquoi, ce qui a été répondu et ' +
      'combien d’images ont transité. Les images, elles, ne sont pas conservées.',
  })
  history(
    @Query('deviceId') deviceId?: string,
    @Query('take', new DefaultValuePipe(25), ParseIntPipe) take = 25,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip = 0,
  ) {
    return this.screenShare.history({
      deviceId,
      take: Math.min(take, 100),
      skip,
    });
  }
}
