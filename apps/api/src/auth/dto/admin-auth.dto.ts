import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@phone-control.local' })
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'ChangeMe!2026', minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'Le mot de passe doit comporter au moins 12 caractères.' })
  @MaxLength(256)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Jeton de rafraîchissement opaque.' })
  @IsString()
  @MaxLength(512)
  refreshToken!: string;
}

export class AdminProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty() role!: string;
  @ApiProperty({ nullable: true }) companyId!: string | null;
  @ApiProperty({ type: [String] }) depotScope!: string[];
}

export class AuthTokensDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ description: 'Durée de vie du jeton d’accès, en secondes.' })
  expiresIn!: number;
  @ApiProperty({ type: AdminProfileDto }) admin!: AdminProfileDto;
}


export class CodeTrajelysDto {
  @ApiProperty({
    description:
      'Code à usage unique obtenu par Trajelys. Il ne vaut qu’une fois et ' +
      'moins d’une minute : il transite par l’URL du navigateur, donc par ' +
      'son historique et par les journaux des proxys traversés.',
  })
  @IsString()
  @MinLength(20)
  code!: string;
}

export class ReponseCodeTrajelysDto {
  @ApiProperty({ description: 'À passer au tableau de bord dans la redirection.' })
  code!: string;

  @ApiProperty({ description: 'Durée de vie restante, en secondes.' })
  expireDansSecondes!: number;
}

export class TrajelysSsoDto {
  @ApiProperty({
    description:
      'Jeton d’accès Supabase de la session Trajelys du manager. Vérifié ' +
      'localement contre le JWKS du projet : il ne quitte jamais cette route.',
  })
  @IsString()
  @MinLength(20)
  token!: string;
}
