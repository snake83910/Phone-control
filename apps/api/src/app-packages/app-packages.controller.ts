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
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { AdminRole } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppPackagesService } from './app-packages.service';
import { APK_CONTENT_TYPE } from './apk-upload';
import {
  AuthenticatedAdmin,
  AuthenticatedDevice,
  CurrentAdmin,
  CurrentDevice,
  DeviceAuth,
  Roles,
} from '../auth/auth.decorators';
import { requireCompany } from '../common/require-company';

export class DeployDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Téléphones visés. **Absent, l’application part sur tous les téléphones ' +
      'enrôlés de l’entreprise** — c’est le serveur qui résout la flotte, et ' +
      'non le tableau de bord qui en énumère deux mille identifiants.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  deviceIds?: string[];
}

export class UninstallDto {
  @ApiProperty({ example: 'com.exemple.application' })
  @Matches(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, {
    message: 'Un nom de paquet est attendu, par exemple com.exemple.application.',
  })
  @MaxLength(255)
  packageName!: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  deviceIds!: string[];
}

export class InstallReportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  packageId!: string;

  @ApiProperty({ example: 'com.exemple.application' })
  @IsString()
  @MaxLength(255)
  packageName!: string;

  @ApiProperty({ example: '2.4.1' })
  @IsString()
  @MaxLength(64)
  versionName!: string;

  @ApiProperty({ example: 2401 })
  @IsInt()
  @Min(0)
  versionCode!: number;
}

/**
 * Catalogue d'applications, cote exploitation.
 *
 * Le depot passe par un corps **brut** : le corps de la requete EST l'APK. Pas
 * de formulaire multipart, pour un seul fichier et aucun autre champ — le
 * libelle voyage en parametre. Cote navigateur, l'envoi tient en une ligne ;
 * cote serveur, cela evite une dependance dont on n'utiliserait rien.
 */
@ApiTags('Applications')
@ApiBearerAuth('admin')
@Controller('v1/app-packages')
export class AppPackagesController {
  constructor(private readonly packages: AppPackagesService) {}

  @Get()
  @ApiOperation({ summary: 'Applications déposées.' })
  findAll(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.packages.findAll(requireCompany(admin));
  }

  @Post()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiConsumes(APK_CONTENT_TYPE)
  @ApiBody({ description: 'Le corps de la requête est l’APK lui-même.' })
  @ApiOperation({
    summary: 'Dépose un APK.',
    description:
      'Le serveur calcule lui-même l’empreinte du fichier et celle du ' +
      'certificat de signature. Elles ne sont jamais saisies : une empreinte ' +
      'fournie par celui qui dépose le fichier décrirait le fichier déposé, ' +
      'quel qu’il soit.',
  })
  upload(
    @Query('label') label: string,
    @Req() request: FastifyRequest,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.packages.upload({
      companyId: requireCompany(admin),
      adminId: admin.id,
      label: label ?? '',
      request,
    });
  }

  @Post(':id/deploy')
  @HttpCode(200)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({
    summary: 'Pousse une application sur des téléphones.',
    description:
      'Une commande par appareil, avec expiration et acquittement. Une même ' +
      'application poussée deux fois ne produit qu’une commande.',
  })
  deploy(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeployDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.packages.deploy({
      companyId: requireCompany(admin),
      adminId: admin.id,
      packageId: id,
      deviceIds: dto.deviceIds,
    });
  }

  @Post('uninstall')
  @HttpCode(200)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({ summary: 'Désinstalle une application sur des téléphones.' })
  uninstall(
    @Body() dto: UninstallDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.packages.uninstall({
      companyId: requireCompany(admin),
      adminId: admin.id,
      packageName: dto.packageName,
      deviceIds: dto.deviceIds,
    });
  }

  @Delete(':id')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({
    summary: 'Retire une application du catalogue.',
    description:
      'Le fichier est supprimé, la ligne reste : elle explique les ' +
      'installations déjà faites.',
  })
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.packages.retire(requireCompany(admin), id);
  }

  // --- Appels du téléphone ---------------------------------------------------

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Get(':id/download')
  @ApiOperation({
    summary: 'Téléchargement de l’APK par un téléphone.',
    description:
      'Aucune route statique ne sert ce répertoire : un APK ne se télécharge ' +
      'qu’avec le jeton d’un appareil enrôlé, et seulement de son entreprise.',
  })
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDevice() device: AuthenticatedDevice,
    @Res() reply: FastifyReply,
  ) {
    const { stream, pkg, sizeBytes } = await this.packages.openForDevice(
      device.companyId,
      id,
    );

    // L'empreinte voyage aussi en en-tête : le téléphone la vérifie de toute
    // façon, mais un opérateur qui débogue avec curl doit pouvoir la comparer
    // sans ouvrir le dashboard.
    void reply
      .header('content-type', APK_CONTENT_TYPE)
      .header('content-length', String(sizeBytes))
      .header('x-apk-sha256', pkg.sha256)
      .send(stream);
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post('installed')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Identité réelle du paquet, après installation.',
    description:
      'Le serveur ne sait pas lire le manifeste binaire d’un APK. Le téléphone, ' +
      'lui, le lit : il rapporte ce qu’il a réellement installé, et le premier ' +
      'rapport fait foi.',
  })
  async reportInstalled(@Body() dto: InstallReportDto) {
    await this.packages.recordInstalledIdentity(dto.packageId, {
      packageName: dto.packageName,
      versionName: dto.versionName,
      versionCode: dto.versionCode,
    });
    return { ok: true };
  }
}
