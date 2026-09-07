import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestContext, TenantContext } from './tenant-context';

type Req = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
};
type Res = { setHeader?: (k: string, v: string) => void; header?: (k: string, v: string) => void };

/**
 * Ouvre le contexte de requête AVANT les guards.
 *
 * Le contexte est créé vide (companyId null) puis complété par le guard
 * d'authentification, qui mute l'objet stocké dans l'AsyncLocalStorage. C'est
 * ce qui permet à l'extension Prisma de connaître l'entreprise active sans
 * qu'aucun service n'ait à la transporter en paramètre.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    const incoming = req.headers['x-correlation-id'];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();

    const userAgent = req.headers['user-agent'];

    const ctx: RequestContext = {
      correlationId,
      companyId: null,
      ip: req.ip ?? req.socket?.remoteAddress,
      userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    };

    if (res.setHeader) res.setHeader('x-correlation-id', correlationId);
    else if (res.header) res.header('x-correlation-id', correlationId);

    TenantContext.run(ctx, next);
  }
}
