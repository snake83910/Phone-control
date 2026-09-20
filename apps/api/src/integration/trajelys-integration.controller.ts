import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ServiceAuth } from '../auth/auth.decorators';
import { TrajelysIntegrationService } from './trajelys-integration.service';
import {
  FenetreFacturationDto,
  ProvisionnerEntrepriseDto,
  ReponseAppareilsDto,
  ReponseProvisionnementDto,
} from './dto/trajelys-integration.dto';

/**
 * Ce que Trajelys a le droit de faire ici, et rien de plus.
 *
 * ── Deux routes, et c'est tout le pouvoir du jeton de service ───────────
 * Créer-et-rattacher une entreprise, et compter des appareils à facturer.
 * Aucune position, aucun chauffeur, aucun badge, aucune commande d'appareil.
 * C'est ce qui permet de poser ce secret dans les variables d'une
 * application web sans lui confier la flotte de tous les clients — ce qu'un
 * compte super-administrateur aurait fait.
 *
 * ── Pourquoi le sens de l'appel est celui-là ────────────────────────────
 * Trajelys tire, ce service ne pousse pas. Facturer est la responsabilité de
 * Trajelys : lui seul connaît Stripe, l'abonnement et le calendrier. Si ce
 * service poussait, il devrait connaître ce calendrier, et il y aurait deux
 * endroits pour se tromper de mois.
 */
@ApiTags('Intégration Trajelys')
@ApiSecurity('service')
@ServiceAuth()
@Controller('v1/integration/trajelys')
export class TrajelysIntegrationController {
  constructor(private readonly integration: TrajelysIntegrationService) {}

  @Post('entreprises')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Crée l’entreprise du client, ou rend celle qui existe déjà.',
    description:
      'Idempotent sur le compte Trajelys. Appelé à l’ouverture du module ' +
      'Téléphones, et de nouveau au premier clic du client — ce qui rattrape ' +
      'une indisponibilité de ce service sans file d’attente.',
  })
  @ApiOkResponse({ type: ReponseProvisionnementDto })
  // 200 et non 201 : l'appel réussit aussi bien quand il ne crée rien, et
  // faire varier le code du succès obligerait l'appelant à distinguer deux
  // cas qui ne le concernent pas. `creee` le dit, pour le journal.
  provisionner(
    @Body() dto: ProvisionnerEntrepriseDto,
  ): Promise<ReponseProvisionnementDto> {
    return this.integration.provisionner(dto.trajelysUserId, dto.nom);
  }

  @Get('appareils')
  @ApiOperation({
    summary: 'Appareils à facturer sur une fenêtre donnée.',
    description:
      'Rend les appareils enrôlés à cet instant, plus ceux retirés depuis le ' +
      'début de la fenêtre. L’histoire des enrôlements passés n’existe pas ' +
      'ici : c’est Trajelys qui accumule et fige.',
  })
  @ApiOkResponse({ type: ReponseAppareilsDto })
  appareils(@Query() query: FenetreFacturationDto): Promise<ReponseAppareilsDto> {
    return this.integration.appareilsFactures(
      query.trajelysUserId,
      new Date(query.debut),
      new Date(query.fin),
    );
  }
}
