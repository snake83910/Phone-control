import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { GeofenceEventType, SecurityEventType, SecuritySeverity } from '@prisma/client';

export enum SyncEventKind {
  LOCATION = 'LOCATION',
  GEOFENCE = 'GEOFENCE',
  SECURITY = 'SECURITY',
  BARCODE_SCAN = 'BARCODE_SCAN',
}

export class SyncEventDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Identifiant généré par l’appareil. Garantit l’idempotence : un lot ' +
      'renvoyé après un délai d’attente ne crée aucun doublon.',
  })
  @IsUUID()
  eventId!: string;

  @ApiProperty({ description: 'Compteur monotone par appareil, pour l’ordre de rejeu.' })
  @IsInt()
  @Min(0)
  seq!: number;

  @ApiProperty({ enum: SyncEventKind })
  @IsEnum(SyncEventKind)
  kind!: SyncEventKind;

  @ApiProperty({ description: 'Horodatage de l’événement sur l’appareil (ISO 8601).' })
  @IsISO8601()
  occurredAt!: string;

  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() accuracyMeters?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() altitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() speedMps?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() bearing?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) provider?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isMock?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() batteryLevel?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() insideGeofence?: boolean;

  @ApiPropertyOptional({ enum: GeofenceEventType })
  @IsOptional() @IsEnum(GeofenceEventType)
  geofenceEventType?: GeofenceEventType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  depotId?: string;

  @ApiPropertyOptional({ description: 'Confiance de la décision du moteur local, 0 à 1.' })
  @IsOptional() @IsNumber()
  confidence?: number;

  @ApiPropertyOptional({
    description:
      'Mesures ayant conduit à la décision du moteur de geofencing. ' +
      'Indispensable pour justifier une alerte contestée.',
  })
  @IsOptional() @IsObject()
  evaluation?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: SecurityEventType })
  @IsOptional() @IsEnum(SecurityEventType)
  securityType?: SecurityEventType;

  @ApiPropertyOptional({ enum: SecuritySeverity })
  @IsOptional() @IsEnum(SecuritySeverity)
  severity?: SecuritySeverity;

  @ApiPropertyOptional() @IsOptional() @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  sessionId?: string;
}

export class SyncEventsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deviceId!: string;

  @ApiProperty({ type: [SyncEventDto], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500, {
    message: 'Un lot ne peut dépasser 500 événements.',
  })
  @ValidateNested({ each: true })
  @Type(() => SyncEventDto)
  events!: SyncEventDto[];
}

export class SyncPullQueryDto {
  @ApiPropertyOptional({
    description:
      'Version de configuration détenue par l’appareil. Si elle est à jour, ' +
      'la réponse ne renvoie pas la configuration.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  configVersion?: number;
}
