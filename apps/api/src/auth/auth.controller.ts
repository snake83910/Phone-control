import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service';
import { BarcodeAuthService } from './barcode-auth.service';
import { AuthTokensDto, LoginDto, RefreshDto } from './dto/admin-auth.dto';
import {
  BarcodeAuthDto,
  BarcodeAuthResponseDto,
} from './dto/barcode-auth.dto';
import {
  AuthenticatedAdmin,
  AuthenticatedDevice,
  CurrentAdmin,
  CurrentDevice,
  DeviceAuth,
  Public,
} from './auth.decorators';

@ApiTags('Authentification')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly barcodeAuth: BarcodeAuthService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Connexion d’un administrateur du dashboard.' })
  @ApiOkResponse({ type: AuthTokensDto })
  login(@Body() dto: LoginDto): Promise<AuthTokensDto> {
    return this.adminAuth.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotation du jeton de rafraîchissement.',
    description:
      'Un jeton ne sert qu’une fois. Sa réutilisation révoque toute la famille ' +
      'de jetons : c’est la détection de vol décrite dans docs/07-securite.md.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensDto> {
    return this.adminAuth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Révoque la famille de jetons de l’administrateur.' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.adminAuth.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth('admin')
  @ApiOperation({
    summary: 'Profil de l’administrateur connecté.',
    description:
      'Le dashboard s’en sert pour construire sa navigation selon le rôle, ' +
      'sans jamais lire le contenu du jeton côté navigateur.',
  })
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return admin;
  }

  @DeviceAuth()
  @ApiBearerAuth('device')
  @Post('barcode')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Authentification d’un chauffeur par son badge Code 128.',
    description:
      'Appelé par le téléphone après lecture du code-barres. Le serveur ' +
      'applique les neuf contrôles (badge, utilisateur, appareil, affectation, ' +
      'entreprise, quotas) et ouvre une session en cas de succès. ' +
      'Un refus renvoie HTTP 200 avec success=false : la requête a abouti, ' +
      'c’est le scan qui est refusé.',
  })
  @ApiOkResponse({ type: BarcodeAuthResponseDto })
  scanBadge(
    @Body() dto: BarcodeAuthDto,
    @CurrentDevice() device: AuthenticatedDevice,
  ): Promise<BarcodeAuthResponseDto> {
    return this.barcodeAuth.authenticate(dto, device.id);
  }
}
