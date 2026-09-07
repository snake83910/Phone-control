import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { newId } from '../common/ids';

/**
 * Paquets que le systeme refuse de masquer, quelle que soit la demande.
 *
 * Ce garde-fou existe en deux endroits, et c'est delibere : le telephone
 * refuse aussi (voir `AppPolicyRules.kt`). Le refus cote serveur explique
 * l'erreur au moment de la saisie, quand l'administrateur peut encore
 * corriger ; le refus cote telephone protege les appareils deja en service, y
 * compris ceux qui recevraient une politique ecrite avant ce controle.
 *
 * Les deux listes doivent rester coherentes. Celle du telephone fait foi : elle
 * est la derniere barriere.
 */
export const PROTECTED_PACKAGES = new Set([
  'android',
  'com.android.systemui',
  'com.android.phone',
  'com.android.server.telecom',
  'com.android.dialer',
  'com.samsung.android.dialer',
  'com.samsung.android.incallui',
  'com.android.emergency',
  'com.android.cellbroadcastreceiver',
  'com.google.android.cellbroadcastreceiver',
  'com.google.android.gms',
  'com.android.vending',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
  'com.sec.android.app.launcher',
  'com.android.launcher3',
]);

/**
 * Forme d'un nom de paquet Android : des segments separes par des points.
 * Verifier ici evite d'envoyer a la flotte une saisie qui ne designera jamais
 * rien -- un nom d'application (« Facebook ») au lieu d'un nom de paquet.
 */
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export class AppPolicyDto {
  @ApiProperty({
    type: [String],
    description:
      'Paquets autorisés à s’ouvrir à côté de l’application pendant une ' +
      'session. Hors de cette liste, rien ne s’ouvre en mode kiosque.',
    example: ['com.google.android.apps.maps'],
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  allowedApps!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Paquets masqués sur le téléphone : ils disparaissent du menu et ne se ' +
      'lancent plus, session ouverte ou non.',
    example: ['com.supercell.clashofclans'],
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  blockedApps!: string[];
}

/**
 * Politique d'applications de l'entreprise.
 *
 * Elle s'ecrit au niveau le plus haut de la cascade (entreprise, puis depot,
 * puis appareil) : c'est le niveau qui correspond a la demande courante,
 * « bloquer telle application sur la flotte ». Les surcharges par depot et par
 * appareil existent deja dans le modele et se piloteront de la meme facon.
 *
 * Rien ici ne bloque quoi que ce soit : cette route enregistre une INTENTION.
 * Ce qui est reellement masque se lit sur la fiche de chaque telephone, dans le
 * constat qu'il remonte apres application (§67).
 */
@ApiTags('Configuration')
@ApiBearerAuth('admin')
@Controller('v1/settings/apps')
export class AppPolicyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Politique d’applications de l’entreprise.',
    description:
      'Intention, pas constat. Ce que chaque téléphone a réellement masqué se ' +
      'lit sur sa fiche.',
  })
  async get(@CurrentAdmin() admin: AuthenticatedAdmin) {
    const row = await this.baseRow(admin);
    return {
      allowedApps: (row.allowedApps as string[]) ?? [],
      blockedApps: (row.blockedApps as string[]) ?? [],
      version: row.version,
      protectedPackages: [...PROTECTED_PACKAGES],
    };
  }

  @Put()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN)
  @ApiOperation({
    summary: 'Remplace la politique d’applications de l’entreprise.',
    description:
      'Remplacement complet, pas fusion : retirer un paquet de la liste des ' +
      'bloqués le fait réapparaître sur les téléphones. C’est ce qui rend un ' +
      'blocage erroné réparable à distance plutôt qu’en atelier.',
  })
  async replace(
    @Body() dto: AppPolicyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const allowedApps = this.clean(dto.allowedApps, 'autorisées');
    const blockedApps = this.clean(dto.blockedApps, 'bloquées');

    const refused = blockedApps.filter((p) => PROTECTED_PACKAGES.has(p));
    if (refused.length > 0) {
      throw new BadRequestException(
        `Ces paquets ne peuvent pas être bloqués : ${refused.join(', ')}. ` +
          'Les masquer rendrait le téléphone inutilisable ou couperait le canal ' +
          'qui permet de le corriger à distance.',
      );
    }

    const before = await this.baseRow(admin);

    // La version sert au téléphone à savoir s'il doit retélécharger sa
    // configuration : sans incrément, la politique ne partirait jamais.
    const after = await this.prisma.raw.deviceSettings.update({
      where: { id: before.id },
      data: { allowedApps, blockedApps, version: { increment: 1 } },
    });

    await this.audit.record({
      action: 'ADMIN_UPDATE_APP_POLICY',
      resourceType: 'device_settings',
      resourceId: after.id,
      before: {
        allowedApps: before.allowedApps,
        blockedApps: before.blockedApps,
      },
      after: { allowedApps, blockedApps },
    });

    return {
      allowedApps,
      blockedApps,
      version: after.version,
      protectedPackages: [...PROTECTED_PACKAGES],
    };
  }

  /**
   * Nettoie et valide une liste de paquets.
   *
   * Les doublons et les lignes vides sont absorbes en silence — ce sont des
   * accidents de saisie sans consequence. Une valeur qui n'est pas un nom de
   * paquet, en revanche, est refusee : acceptee, elle produirait une politique
   * qui ne designe rien et un administrateur convaincu d'avoir bloque une
   * application.
   */
  private clean(values: string[], listName: string): string[] {
    const cleaned: string[] = [];

    for (const raw of values) {
      const value = raw.trim();
      if (value.length === 0) continue;
      if (!PACKAGE_PATTERN.test(value)) {
        throw new BadRequestException(
          `« ${value} » n'est pas un nom de paquet Android (liste des ${listName}). ` +
            'Un nom de paquet ressemble à « com.google.android.apps.maps », et se ' +
            'lit dans l’adresse de la fiche Play Store de l’application.',
        );
      }
      if (!cleaned.includes(value)) cleaned.push(value);
    }

    return cleaned;
  }

  /** Ligne de configuration au niveau entreprise : ni dépôt, ni appareil. */
  private async baseRow(admin: AuthenticatedAdmin) {
    const companyId = admin.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'Un super-administrateur doit se rattacher à une entreprise pour ' +
          'modifier sa politique d’applications.',
      );
    }

    const existing = await this.prisma.raw.deviceSettings.findFirst({
      where: { companyId, depotId: null, deviceId: null },
    });
    if (existing) return existing;

    // Une entreprise créée avant l'existence de cette ligne n'en a pas : la
    // créer ici évite un 404 incompréhensible sur une page de configuration.
    const created = await this.prisma.raw.deviceSettings.create({
      data: { id: newId(), companyId },
    });
    if (!created) throw new NotFoundException('Configuration introuvable.');
    return created;
  }
}
