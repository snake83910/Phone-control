import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'Rémy' })
  @IsString() @MinLength(1) @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Simon' })
  @IsString() @MinLength(1) @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  depotId?: string;

  @ApiPropertyOptional({ example: 'MAT-0421' })
  @IsOptional() @IsString() @MaxLength(64)
  employeeNumber?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsEmail() @MaxLength(255)
  email?: string;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class AssignDeviceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deviceId!: string;
}
