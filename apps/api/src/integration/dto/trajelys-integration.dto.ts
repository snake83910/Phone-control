import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ProvisionnerEntrepriseDto {
  @ApiProperty({
    description:
      'Compte Trajelys du client — `dsp.user_id`. C’est la clé du lien entre ' +
      'les deux produits, et elle est unique côté entreprises.',
    example: '65302aeb-03c6-4b0e-9649-9093bfdb7c7a',
  })
  @IsUUID()
  trajelysUserId!: string;

  @ApiProperty({ description: 'Raison sociale, telle que connue de Trajelys.' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  nom!: string;
}

export class ReponseProvisionnementDto {
  @ApiProperty() companyId!: string;
  @ApiProperty() nom!: string;
  @ApiProperty() slug!: string;

  @ApiProperty({
    description:
      'Faux quand l’entreprise existait déjà. L’appel est idempotent : ' +
      'rouvrir l’option ne crée pas une seconde flotte.',
  })
  creee!: boolean;
}

/**
 * Fenêtre de facturation.
 *
 * ── Pourquoi des instants, et pas une année et un mois ──────────────────
 * Parce que « septembre » n'est pas la même chose ici et là-bas. Trajelys
 * facture sur des mois d'Europe/Paris ; ce service vit en UTC. Un appareil
 * retiré le 1er octobre à 00 h 30 à Paris l'a été le 30 septembre à 22 h 30
 * en UTC — et les deux produits le compteraient sur des mois différents.
 *
 * Le propriétaire de la facturation envoie donc les bornes qu'il utilise, et
 * ce service n'a aucune arithmétique de calendrier à faire. C'est un endroit
 * de moins où les deux peuvent diverger.
 */
export class FenetreFacturationDto {
  @ApiProperty({ example: '2026-08-31T22:00:00.000Z' })
  @IsISO8601()
  debut!: string;

  @ApiProperty({ example: '2026-09-30T22:00:00.000Z' })
  @IsISO8601()
  fin!: string;

  @ApiProperty({ example: '65302aeb-03c6-4b0e-9649-9093bfdb7c7a' })
  @IsUUID()
  trajelysUserId!: string;
}

export class AppareilFactureDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Numéro de parc, pour la trace de facturation.' })
  assetTag!: string;
}

export class ReponseAppareilsDto {
  @ApiProperty() companyId!: string;
  @ApiProperty({ type: [AppareilFactureDto] }) appareils!: AppareilFactureDto[];
}
