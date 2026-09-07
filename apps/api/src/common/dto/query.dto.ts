import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AlertStatus,
  AlertType,
  BadgeStatus,
  DeviceState,
  SessionStatus,
  UserStatus,
} from '@prisma/client';

/**
 * Filtres de liste.
 *
 * Chaque endpoint a sa propre CLASSE, et non un type intersection du genre
 * `PaginationDto & { depotId?: string }`. La raison est concrète : Nest lit le
 * type du paramètre via les métadonnées de décorateur, et un type intersection
 * n'est pas une classe — la ValidationPipe est alors silencieusement ignorée,
 * `take` reste la chaîne « 200 » et la requête Prisma échoue en production.
 * Ce piège a été trouvé par les tests d'intégration ; il ne doit pas revenir.
 */
export class PaginationDto {
  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

export class DeviceListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  depotId?: string;

  @ApiPropertyOptional({ enum: DeviceState })
  @IsOptional()
  @IsEnum(DeviceState)
  state?: DeviceState;
}

export class UserListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  depotId?: string;

  @ApiPropertyOptional({ description: 'Nom, prénom ou matricule.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class BadgeListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ enum: BadgeStatus })
  @IsOptional()
  @IsEnum(BadgeStatus)
  status?: BadgeStatus;
}

export class SessionListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ enum: SessionStatus })
  @IsOptional()
  @IsEnum(SessionStatus)
  status?: SessionStatus;
}

export class AlertListQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: AlertStatus })
  @IsOptional()
  @IsEnum(AlertStatus)
  status?: AlertStatus;

  @ApiPropertyOptional({ enum: AlertType })
  @IsOptional()
  @IsEnum(AlertType)
  type?: AlertType;
}
