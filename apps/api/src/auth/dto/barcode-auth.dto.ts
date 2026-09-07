import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class BarcodeAuthDto {
  @ApiProperty({
    example: '14557719',
    description:
      'Valeur brute lue sur le badge (Code 128). Elle est normalisée puis ' +
      'hachée côté serveur : elle n’est jamais stockée en clair.',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  // Tolère les séparateurs que certains scanners insèrent ; la normalisation
  // les retire. Le format cible reste numérique à 8 chiffres.
  @Matches(/^[A-Za-z0-9\s\-.]+$/, {
    message: 'Le code-barres contient des caractères inattendus.',
  })
  barcode!: string;

  @ApiProperty({ format: 'uuid', description: 'Identifiant de l’appareil.' })
  @IsUUID()
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Horodatage du scan sur l’appareil (ISO 8601).' })
  @IsOptional()
  @IsISO8601()
  scannedAt?: string;

  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
}

export type BarcodeDenialReason =
  | 'BADGE_DENIED'
  | 'DEVICE_NOT_AUTHORIZED'
  | 'DEVICE_UNAVAILABLE'
  | 'RATE_LIMITED';

export class BarcodeAuthUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
}

export class BarcodeAuthSessionDto {
  @ApiProperty() id!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() startedAt!: string;
}

export class BarcodeAuthResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiPropertyOptional({ type: BarcodeAuthUserDto })
  user?: BarcodeAuthUserDto;

  @ApiPropertyOptional({ type: BarcodeAuthSessionDto })
  session?: BarcodeAuthSessionDto;

  @ApiPropertyOptional({
    description:
      'Motif de refus, à granularité volontairement grossière. ' +
      'BADGE_DENIED couvre indistinctement badge inconnu, révoqué ou ' +
      'utilisateur désactivé, afin de ne pas transformer l’écran de scan en ' +
      'oracle d’existence de badges.',
  })
  reason?: BarcodeDenialReason;

  @ApiPropertyOptional({ description: 'Message affichable sur le téléphone.' })
  message?: string;

  @ApiPropertyOptional({ description: 'Délai avant nouvel essai, en secondes.' })
  retryAfterSeconds?: number;
}
