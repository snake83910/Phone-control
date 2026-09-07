import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommandType, KioskMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  IsObject,
} from 'class-validator';

export class EnrollDeviceDto {
  @ApiProperty({ example: 'ETK-ABCD2345-EFGH6789' })
  @IsString()
  @MaxLength(64)
  enrollmentToken!: string;

  @ApiPropertyOptional({ example: 'R58N70ABCDE' })
  @IsOptional() @IsString() @MaxLength(128)
  serialNumber?: string;

  @ApiPropertyOptional({ example: '350123456789012' })
  @IsOptional() @IsString() @MaxLength(32)
  imei?: string;

  @ApiPropertyOptional({ example: 'samsung' })
  @IsOptional() @IsString() @MaxLength(64)
  manufacturer?: string;

  @ApiPropertyOptional({ example: 'SM-A165F' })
  @IsOptional() @IsString() @MaxLength(64)
  model?: string;

  @ApiPropertyOptional({ example: '14' })
  @IsOptional() @IsString() @MaxLength(32)
  androidVersion?: string;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional() @IsString() @MaxLength(32)
  appVersion?: string;

  @ApiPropertyOptional({
    description:
      'Clé publique attestée du Keystore Android, en base64. Sert à lier les ' +
      'jetons de rafraîchissement à ce matériel précis.',
  })
  @IsOptional() @IsString() @MaxLength(4096)
  publicKey?: string;

  @ApiProperty({
    description:
      'L’application est-elle réellement Device Owner ? Déclaratif : le ' +
      'dashboard affiche « non confirmé » tant que ce champ est faux, plutôt ' +
      'que de laisser croire à une protection inexistante.',
  })
  @IsBoolean()
  deviceOwnerActive!: boolean;
}

export class HeartbeatDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deviceId!: string;

  @ApiPropertyOptional({ example: 72, minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  battery?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional() @IsBoolean()
  charging?: boolean;

  @ApiPropertyOptional({ example: 'wifi', enum: ['wifi', 'mobile', 'none'] })
  @IsOptional() @IsString() @MaxLength(16)
  network?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional() @IsBoolean()
  gps?: boolean;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional() @IsString() @MaxLength(32)
  appVersion?: string;

  @ApiPropertyOptional({ example: '14' })
  @IsOptional() @IsString() @MaxLength(32)
  androidVersion?: string;

  @ApiPropertyOptional({ example: 24576 })
  @IsOptional() @IsInt() @Min(0)
  storageFreeMb?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  deviceOwnerActive?: boolean;

  @ApiPropertyOptional({
    description:
      'Jeton Firebase Cloud Messaging, pour le réveil rapide. Absent sur un ' +
      'terminal sans services Google : le sondage périodique prend alors le relais.',
  })
  @IsOptional() @IsString() @MaxLength(512)
  fcmToken?: string;
}

export class CreateDeviceDto {
  @ApiProperty({ example: 'TEL-023' })
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,31}$/, {
    message: 'Format attendu : majuscules, chiffres et tirets (ex. TEL-023).',
  })
  assetTag!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  depotId?: string;

  @ApiPropertyOptional({ enum: KioskMode, default: KioskMode.KIOSK })
  @IsOptional() @IsEnum(KioskMode)
  kioskMode?: KioskMode;
}

export class CreateCommandDto {
  @ApiProperty({ enum: CommandType })
  @IsEnum(CommandType)
  command!: CommandType;

  @ApiPropertyOptional({ type: Object, default: {} })
  @IsOptional() @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Durée de validité en minutes.', default: 720 })
  @IsOptional() @IsInt() @Min(1) @Max(20160)
  ttlMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Clé d’idempotence : deux appels avec la même clé ne créent qu’une commande.',
  })
  @IsOptional() @IsString() @MaxLength(128)
  idempotencyKey?: string;
}

export class CommandResultDto {
  @ApiProperty({ enum: ['EXECUTED', 'FAILED'] })
  @IsString()
  @Matches(/^(EXECUTED|FAILED)$/)
  status!: 'EXECUTED' | 'FAILED';

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1024)
  error?: string;
}

/**
 * Un refus, tel que le telephone le rapporte.
 *
 * Un refus n'est pas une erreur : c'est le systeme, ou la regle de securite,
 * qui a dit non. Le distinguer d'un succes est tout l'interet de cette
 * remontee -- sans elle, le tableau de bord afficherait « bloquee » pour une
 * application parfaitement accessible.
 */
export class AppRefusalDto {
  @ApiProperty({ example: 'com.android.systemui' })
  @IsString()
  @MaxLength(255)
  packageName!: string;

  @ApiProperty({
    enum: ['SELF', 'PROTECTED', 'NOT_INSTALLED', 'CONFLICT', 'SYSTEM_REFUSED'],
    description:
      'SELF : l’application de gestion elle-même. ' +
      'PROTECTED : paquet système dont le masquage rendrait le téléphone ' +
      'inutilisable. NOT_INSTALLED : absent du téléphone, le plus souvent une ' +
      'faute de frappe dans le nom du paquet. CONFLICT : présent dans les deux ' +
      'listes. SYSTEM_REFUSED : Android a refusé le masquage.',
  })
  @IsIn(['SELF', 'PROTECTED', 'NOT_INSTALLED', 'CONFLICT', 'SYSTEM_REFUSED'])
  reason!: string;
}

/**
 * Ce que le telephone a REELLEMENT applique de la politique d'applications.
 *
 * Cette route existe pour une raison precise : la liste des applications
 * bloquees affichee dans le tableau de bord doit etre un constat, pas une
 * intention. Un telephone sans Device Owner ne masque rien du tout, et
 * l'afficher comme verrouille serait exactement ce que la specification §67
 * interdit.
 */
export class AppPolicyReportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deviceId!: string;

  @ApiProperty({
    description:
      'Faux quand l’application n’est pas Device Owner : aucune application ' +
      'n’est alors masquée, quelle que soit la configuration.',
  })
  @IsBoolean()
  enforced!: boolean;

  @ApiProperty({ description: 'Version de configuration à laquelle ce constat se rapporte.' })
  @IsInt()
  @Min(0)
  configVersion!: number;

  @ApiProperty({ type: [String], example: ['com.supercell.clashofclans'] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  @MaxLength(255, { each: true })
  hidden!: string[];

  @ApiProperty({ type: [AppRefusalDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AppRefusalDto)
  refusals!: AppRefusalDto[];
}
