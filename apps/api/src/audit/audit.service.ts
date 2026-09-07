import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newId } from '../common/ids';
import { TenantContext } from '../common/tenant-context';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Journal d'audit des actions administratives (§41 de la spécification).
 *
 * La table est protégée en base par un trigger qui refuse UPDATE et DELETE :
 * un journal modifiable par l'application ne prouve rien. L'écriture ne doit
 * jamais faire échouer l'action métier qu'elle trace, d'où la capture d'erreur.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    const ctx = TenantContext.get();
    try {
      await this.prisma.raw.auditLog.create({
        data: {
          id: newId(),
          companyId: ctx?.companyId ?? null,
          adminId: ctx?.adminId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: ctx?.ip ?? null,
          userAgent: ctx?.userAgent ?? null,
          correlationId: ctx?.correlationId ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Écriture du journal d'audit impossible (${entry.action}) : ${(err as Error).message}`,
      );
    }
  }
}
