import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateDepotDto {
  @ApiProperty({ example: 'MRS' })
  @IsString() @MaxLength(32)
  code!: string;

  @ApiProperty({ example: 'Dépôt Marseille' })
  @IsString() @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 43.296482 })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 5.36978 })
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ default: 250, description: 'Rayon du geofence, en mètres.' })
  @IsOptional() @IsInt() @Min(50) @Max(5000)
  radiusMeters?: number;

  @ApiPropertyOptional({
    default: 75,
    description:
      'Marge supplémentaire exigée pour considérer une sortie. Rend la sortie ' +
      'plus difficile que l’entrée, ce qui évite les oscillations sur la limite.',
  })
  @IsOptional() @IsInt() @Min(0) @Max(2000)
  exitHysteresisMeters?: number;

  @ApiPropertyOptional({ default: 'Europe/Paris' })
  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ default: '18:00', description: 'Heure locale de retour.' })
  @IsOptional() @Matches(TIME, { message: 'returnTime : format HH:mm attendu.' })
  returnTime?: string;

  @ApiPropertyOptional({ default: '22:00', description: 'Heure locale de verrouillage.' })
  @IsOptional() @Matches(TIME, { message: 'lockTime : format HH:mm attendu.' })
  lockTime?: string;

  @ApiPropertyOptional({
    default: '04:00',
    description:
      'Début du jour opérationnel. Permet à un verrouillage après minuit ' +
      'd’être rattaché à la bonne journée de travail.',
  })
  @IsOptional() @Matches(TIME, { message: 'operationalDayStart : format HH:mm attendu.' })
  operationalDayStart?: string;

  @ApiPropertyOptional({
    description: 'Surcharges { weekdays, holidays, special } — cf. docs/03 §3.',
  })
  @IsOptional() @IsObject()
  scheduleOverrides?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'BSSID/SSID du dépôt, indices de présence.' })
  @IsOptional() @IsArray()
  wifiHints?: unknown[];
}

export class UpdateDepotDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(50) @Max(5000) radiusMeters?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(2000) exitHysteresisMeters?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) timezone?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(TIME) returnTime?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(TIME) lockTime?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(TIME) operationalDayStart?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() scheduleOverrides?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsArray() wifiHints?: unknown[];
}
