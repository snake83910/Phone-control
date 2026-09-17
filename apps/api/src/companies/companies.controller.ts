import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  Max,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AdminRole, CompanyStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import { newId } from '../common/ids';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Transports Martin' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'transports-martin' })
  @Matches(/^[a-z0-9][a-z0-9-]{1,60}$/, {
    message: 'Le slug doit être en minuscules, chiffres et tirets.',
  })
  slug!: string;
}

/**
 * Plafond de la rétention des positions.
 *
 * La CNIL pose deux mois en base active pour la géolocalisation de salariés ;
 * elle admet un an, mais en archivage intermédiaire et seulement quand la
 * preuve de la prestation ne peut être apportée autrement. Un an est donc le
 * maximum absolu, jamais un réglage anodin — d'où un plafond plutôt qu'un
 * champ libre, où rien n'empêchait jusqu'ici de saisir dix ans.
 */
export const RETENTION_POSITIONS_MAX_JOURS = 365;

export class UpdateRetentionDto {
  @ApiPropertyOptional({
    default: 60,
    maximum: RETENTION_POSITIONS_MAX_JOURS,
    description:
      'Rétention des positions GPS, en jours. Deux mois est le plafond CNIL en ' +
      'base active ; au-delà, il faut pouvoir justifier que la preuve de la ' +
      'prestation ne peut être apportée autrement.',
  })
  @IsOptional() @IsInt() @Min(1) @Max(RETENTION_POSITIONS_MAX_JOURS)
  locationEventsDays?: number;

  @ApiPropertyOptional({ default: 365 })
  @IsOptional() @IsInt() @Min(1)
  geofenceEventsDays?: number;

  @ApiPropertyOptional({ default: 365 })
  @IsOptional() @IsInt() @Min(1)
  securityEventsDays?: number;

  @ApiPropertyOptional({ default: 1095 })
  @IsOptional() @IsInt() @Min(1)
  sessionsDays?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Autorise la commande LOCATE_NOW sur un téléphone verrouillé. Point RGPD ' +
      'sensible : localiser hors session sort du cadre du temps de travail. ' +
      'Désactivé par défaut, et toujours audité.',
  })
  @IsOptional() @IsBoolean()
  allowLocateWhenLocked?: boolean;
}

export class UpdateCompanyDto {
  @ApiPropertyOptional()
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: CompanyStatus })
  @IsOptional() @IsEnum(CompanyStatus)
  status?: CompanyStatus;

  @ApiPropertyOptional({
    description:
      'Affiche « Ce téléphone n’est pas autorisé pour cet utilisateur » plutôt ' +
      'qu’un refus générique. Utile en exploitation, mais révèle qu’un badge ' +
      'scanné est valide.',
  })
  @IsOptional() @IsBoolean()
  detailedDenialMessages?: boolean;
}

/**
 * Administration des entreprises — réservée au SUPER_ADMIN.
 *
 * Ce contrôleur est le seul à travailler hors d'une entreprise donnée : le
 * SUPER_ADMIN n'est rattaché à aucune, ce qui active le mode inter-entreprises
 * du contexte (cf. AccessGuard).
 */
@ApiTags('Entreprises')
@ApiBearerAuth('admin')
@Roles(AdminRole.SUPER_ADMIN)
@Controller('v1/companies')
export class CompaniesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liste des entreprises.' })
  list() {
    return this.prisma.raw.company.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { devices: true, users: true, depots: true, admins: true } },
      },
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une entreprise et sa politique de rétention.' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const company = await this.prisma.raw.company.findFirst({
      where: { id, deletedAt: null },
      include: {
        retentionPolicy: true,
        depots: { where: { deletedAt: null }, orderBy: { name: 'asc' } },
        _count: { select: { devices: true, users: true, admins: true } },
      },
    });
    if (!company) throw new NotFoundException('Entreprise introuvable.');
    return company;
  }

  @Post()
  @ApiOperation({
    summary: 'Crée une entreprise, sa politique de rétention et ses réglages par défaut.',
  })
  async create(@Body() dto: CreateCompanyDto) {
    const company = await this.prisma.raw.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          id: newId(),
          name: dto.name,
          slug: dto.slug,
          settings: { detailedDenialMessages: true },
        },
      });
      // Sans ces deux lignes, une entreprise neuve n'aurait ni durée de
      // conservation ni configuration d'appareil : deux manques qui ne se
      // verraient qu'au premier téléphone enrôlé.
      await tx.retentionPolicy.create({ data: { companyId: created.id } });
      await tx.deviceSettings.create({
        data: { id: newId(), companyId: created.id },
      });
      return created;
    });

    await this.audit.record({
      action: 'ADMIN_CREATE_COMPANY',
      resourceType: 'company',
      resourceId: company.id,
      after: { name: company.name, slug: company.slug },
    });
    return company;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modifie une entreprise.' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    const before = await this.prisma.raw.company.findFirst({ where: { id } });
    if (!before) throw new NotFoundException('Entreprise introuvable.');

    const settings =
      dto.detailedDenialMessages === undefined
        ? undefined
        : {
            ...((before.settings as Record<string, unknown>) ?? {}),
            detailedDenialMessages: dto.detailedDenialMessages,
          };

    const company = await this.prisma.raw.company.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(settings ? { settings: settings as never } : {}),
      },
    });

    await this.audit.record({
      action: 'ADMIN_UPDATE_COMPANY',
      resourceType: 'company',
      resourceId: id,
      before: { name: before.name, status: before.status, settings: before.settings },
      after: dto,
    });
    return company;
  }

  @Patch(':id/retention')
  @ApiOperation({
    summary: 'Politique de conservation des données (RGPD).',
    description:
      'Les positions GPS sont purgées par suppression de partition mensuelle : ' +
      'réduire cette durée libère réellement l’espace, sans gonfler la table.',
  })
  async updateRetention(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRetentionDto,
  ) {
    const before = await this.prisma.raw.retentionPolicy.findFirst({
      where: { companyId: id },
    });
    if (!before) throw new NotFoundException('Entreprise introuvable.');

    const policy = await this.prisma.raw.retentionPolicy.update({
      where: { companyId: id },
      data: { ...dto },
    });

    await this.audit.record({
      action: 'ADMIN_UPDATE_RETENTION',
      resourceType: 'company',
      resourceId: id,
      before,
      after: dto,
    });
    return policy;
  }
}
