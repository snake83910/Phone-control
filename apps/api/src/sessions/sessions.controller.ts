import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRole, SessionEndReason } from '@prisma/client';
import { SessionsService } from './sessions.service';
import { CommandsService } from '../devices/commands.service';
import { AuditService } from '../audit/audit.service';
import {
  AuthenticatedAdmin,
  CurrentAdmin,
  Roles,
} from '../auth/auth.decorators';
import { SessionListQueryDto } from '../common/dto/query.dto';

@ApiTags('Sessions')
@ApiBearerAuth('admin')
@Controller('v1/sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Historique des sessions.' })
  list(@Query() query: SessionListQueryDto) {
    return this.sessions.findAll({
      deviceId: query.deviceId,
      userId: query.userId,
      status: query.status,
      take: query.take ?? 50,
      skip: query.skip ?? 0,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Détail d’une session.' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.findOne(id);
  }

  @Post(':id/end')
  @HttpCode(204)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.COMPANY_ADMIN, AdminRole.DEPOT_ADMIN)
  @ApiOperation({
    summary: 'Termine une session et ordonne le verrouillage du téléphone.',
    description:
      'La clôture en base ne suffit pas : une commande FORCE_LOGOUT est émise, ' +
      'car seule l’exécution par le téléphone le verrouille réellement.',
  })
  async end(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    const session = await this.sessions.findOne(id);
    await this.sessions.end(id, SessionEndReason.ADMIN_LOGOUT, admin.id);
    await this.commands.enqueue({
      companyId: session.companyId,
      deviceId: session.deviceId,
      command: 'FORCE_LOGOUT',
      createdBy: admin.id,
      idempotencyKey: `force-logout:${id}`,
    });
    await this.audit.record({
      action: 'ADMIN_END_SESSION',
      resourceType: 'session',
      resourceId: id,
      before: { status: session.status },
      after: { status: 'ENDED', reason: SessionEndReason.ADMIN_LOGOUT },
    });
  }
}
