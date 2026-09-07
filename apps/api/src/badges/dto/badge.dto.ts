import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BadgeStatus, BarcodeType } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';

export class CreateBadgeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    example: '14557719',
    description:
      'Valeur imprimée sur le badge. Elle est normalisée puis hachée : ' +
      'la base ne conserve jamais le numéro en clair, et l’API ne le renvoie jamais.',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9\s\-.]+$/)
  barcode!: string;

  @ApiPropertyOptional({ enum: BarcodeType, default: BarcodeType.CODE_128 })
  @IsOptional()
  @IsEnum(BarcodeType)
  barcodeType?: BarcodeType;
}

export class UpdateBadgeStatusDto {
  @ApiProperty({ enum: BadgeStatus })
  @IsEnum(BadgeStatus)
  status!: BadgeStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}

export class ReassignBadgeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;
}
