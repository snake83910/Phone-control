import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthService } from './admin-auth.service';
import { TrajelysSsoService } from './trajelys-sso.service';
import { BarcodeAuthService } from './barcode-auth.service';
import {
  AuthTokensDto,
  LoginDto,
  RefreshDto,
  CodeTrajelysDto,
  ReponseCodeTrajelysDto,
  TrajelysSsoDto,
} from './dto/admin-auth.dto';
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
    private readonly trajelys: TrajelysSsoService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Connexion d’un administrateur du dashboard.' })
  @ApiOkResponse({ type: AuthTokensDto })
  login(@Body() dto: LoginDto): Promise<AuthTokensDto> {
    return this.adminAuth.login(dto.email, dto.password);
  }

  /**
   * Échange un jeton Trajelys contre une session Phone Control.
   *
   * Le manager s'est déjà authentifié chez Trajelys ; il n'a pas à le refaire
   * ici. Le jeton reçu est vérifié localement contre le JWKS de Trajelys, puis
   * échangé : au-delà de cette route, plus rien ne connaît Trajelys.
   */
  @Public()
  @Post('trajelys')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Authentification unique depuis Trajelys.',
    description:
      'Prend un jeton Supabase émis par Trajelys et rend les jetons de ce ' +
      "service. L'entreprise doit avoir été rattachée au préalable.",
  })
  @ApiOkResponse({ type: AuthTokensDto })
  async trajelysSso(@Body() dto: TrajelysSsoDto): Promise<AuthTokensDto> {
    const identite = await this.trajelys.verifier(dto.token);
    return this.adminAuth.connecterParTrajelys(identite);
  }

  /**
   * Émet un code à usage unique, pour franchir la frontière d'origine.
   *
   * Trajelys vit sur `www.<domaine>`, le tableau de bord sur `admin.<domaine>`.
   * Des jetons obtenus par la route ci-dessus resteraient enfermés du côté de
   * Trajelys : le navigateur interdit à une origine de poser la session d'une
   * autre. Trajelys obtient donc un code, redirige avec, et le tableau de bord
   * l'échange chez lui.
   *
   * Ce qui passe dans l'URL n'est ainsi ni le jeton Supabase du client, ni un
   * jeton de ce service.
   */
  @Public()
  @Post('trajelys/code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Code à usage unique pour ouvrir le tableau de bord.' })
  @ApiOkResponse({ type: ReponseCodeTrajelysDto })
  async trajelysCode(@Body() dto: TrajelysSsoDto): Promise<ReponseCodeTrajelysDto> {
    const identite = await this.trajelys.verifier(dto.token);
    return this.adminAuth.emettreCodeTrajelys(identite);
  }

  @Public()
  @Post('trajelys/echange')
  @HttpCode(200)
  @ApiOperation({ summary: 'Échange le code contre les jetons de ce service.' })
  @ApiOkResponse({ type: AuthTokensDto })
  async trajelysEchange(@Body() dto: CodeTrajelysDto): Promise<AuthTokensDto> {
    return this.adminAuth.echangerCodeTrajelys(dto.code);
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
