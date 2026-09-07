import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CommandStatus,
  CommandType,
  DeviceCommand,
  DeviceState,
  Prisma,
  SecurityEventType,
  SecuritySeverity,
  SessionEndReason,
  SessionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { newId } from '../common/ids';

const DEFAULT_TTL_MINUTES = 720;

/**
 * File de commandes serveur -> téléphone (§31 de la spécification).
 *
 * Deux principes :
 *  - toute commande EXPIRE : verrouiller un téléphone sur un ordre vieux de
 *    trois jours n'a aucun sens ;
 *  - toute exécution est IDEMPOTENTE : verrouiller un téléphone déjà verrouillé
 *    ne produit ni erreur ni effet, ce qui rend le rejeu inoffensif après une
 *    réponse HTTP perdue.
 */
@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  async enqueue(params: {
    companyId: string;
    deviceId: string;
    command: CommandType;
    payload?: Record<string, unknown>;
    ttlMinutes?: number;
    createdBy?: string | null;
    idempotencyKey?: string | null;
    priority?: number;
  }): Promise<DeviceCommand> {
    const ttl = params.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const data: Prisma.DeviceCommandUncheckedCreateInput = {
      id: newId(),
      companyId: params.companyId,
      deviceId: params.deviceId,
      command: params.command,
      payload: (params.payload ?? {}) as Prisma.InputJsonValue,
      status: CommandStatus.PENDING,
      priority: params.priority ?? defaultPriority(params.command),
      createdBy: params.createdBy ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      expiresAt: new Date(Date.now() + ttl * 60_000),
    };

    // Pré-vérification de la clé d'idempotence : la contrainte en base reste
    // l'autorité, mais la consulter d'abord évite de journaliser une erreur
    // PostgreSQL sur un comportement parfaitement nominal (le planificateur
    // réémet la même commande de verrouillage à chaque cycle).
    if (params.idempotencyKey) {
      const known = await this.prisma.raw.deviceCommand.findFirst({
        where: {
          deviceId: params.deviceId,
          idempotencyKey: params.idempotencyKey,
        },
      });
      if (known) return known;
    }

    try {
      const created = await this.prisma.raw.deviceCommand.create({ data });

      // Réveil du téléphone. Volontairement NON attendu : le sondage périodique
      // reste le canal fiable, et un service Google lent ne doit pas retarder
      // la réponse au dashboard. `wake` ne lève jamais.
      void this.push.wake(params.deviceId, {
        reason: params.command,
        commandId: created.id,
      });

      return created;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        params.idempotencyKey
      ) {
        const existing = await this.prisma.raw.deviceCommand.findFirst({
          where: {
            deviceId: params.deviceId,
            idempotencyKey: params.idempotencyKey,
          },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /** Commandes à livrer, récupérées par le téléphone lors d'une synchronisation. */
  async pullPending(deviceId: string): Promise<DeviceCommand[]> {
    const now = new Date();

    // Purge des commandes périmées avant livraison : le téléphone ne doit
    // jamais recevoir un ordre dont la fenêtre est passée.
    await this.prisma.raw.deviceCommand.updateMany({
      where: {
        deviceId,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
        expiresAt: { lt: now },
      },
      data: { status: CommandStatus.EXPIRED },
    });

    const commands = await this.prisma.raw.deviceCommand.findMany({
      where: {
        deviceId,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
        expiresAt: { gte: now },
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 50,
    });

    if (commands.length > 0) {
      await this.prisma.raw.deviceCommand.updateMany({
        where: { id: { in: commands.map((c) => c.id) } },
        data: {
          status: CommandStatus.SENT,
          sentAt: now,
          attempts: { increment: 1 },
        },
      });
    }

    return commands;
  }

  /** Acquittement d'exécution par le téléphone. */
  async reportResult(
    deviceId: string,
    commandId: string,
    status: 'EXECUTED' | 'FAILED',
    error?: string,
  ): Promise<void> {
    const command = await this.prisma.raw.deviceCommand.findFirst({
      where: { id: commandId, deviceId },
    });
    if (!command) throw new NotFoundException('Commande introuvable pour cet appareil.');

    // Rejeu d'un acquittement déjà reçu : sans effet, sans erreur.
    if (command.status === CommandStatus.EXECUTED) return;

    const now = new Date();
    await this.prisma.raw.$transaction(async (tx) => {
      await tx.deviceCommand.update({
        where: { id: commandId },
        data: {
          status:
            status === 'EXECUTED' ? CommandStatus.EXECUTED : CommandStatus.FAILED,
          executedAt: status === 'EXECUTED' ? now : null,
          deliveredAt: command.deliveredAt ?? now,
          error: error ?? null,
        },
      });

      if (status === 'EXECUTED') {
        await this.applySideEffects(tx, command, now);
      }
    });

    await this.prisma.raw.securityEvent.create({
      data: {
        id: newId(),
        companyId: command.companyId,
        deviceId,
        type:
          status === 'EXECUTED'
            ? command.command === CommandType.LOCK_DEVICE
              ? SecurityEventType.LOCK_DEVICE
              : command.command === CommandType.UNLOCK_DEVICE
                ? SecurityEventType.UNLOCK_DEVICE
                : SecurityEventType.COMMAND_FAILED
            : SecurityEventType.COMMAND_FAILED,
        severity:
          status === 'EXECUTED' ? SecuritySeverity.LOW : SecuritySeverity.MEDIUM,
        occurredAt: now,
        metadata: {
          commandId,
          command: command.command,
          error: error ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Effets de bord serveur d'une commande exécutée. Ils sont appliqués à
   * l'acquittement, pas à l'émission : tant que le téléphone n'a pas confirmé,
   * le serveur ne prétend pas qu'il est verrouillé.
   */
  private async applySideEffects(
    tx: Prisma.TransactionClient,
    command: DeviceCommand,
    now: Date,
  ): Promise<void> {
    switch (command.command) {
      case CommandType.LOCK_DEVICE:
        await tx.session.updateMany({
          where: { deviceId: command.deviceId, status: SessionStatus.ACTIVE },
          data: {
            status: SessionStatus.ENDED,
            endedAt: now,
            endReason: SessionEndReason.SCHEDULED_LOCK,
          },
        });
        await tx.device.update({
          where: { id: command.deviceId },
          data: { state: DeviceState.LOCKED },
        });
        break;

      case CommandType.FORCE_LOGOUT:
      case CommandType.REVOKE_SESSION:
        await tx.session.updateMany({
          where: { deviceId: command.deviceId, status: SessionStatus.ACTIVE },
          data: {
            status: SessionStatus.REVOKED,
            endedAt: now,
            endReason: SessionEndReason.REVOKED,
          },
        });
        await tx.device.update({
          where: { id: command.deviceId },
          data: { state: DeviceState.LOCKED },
        });
        break;

      case CommandType.UNLOCK_DEVICE:
        // Le déverrouillage à distance rend le téléphone utilisable, mais
        // n'ouvre AUCUNE session : il n'y a pas de chauffeur identifié.
        await tx.device.update({
          where: { id: command.deviceId },
          data: { state: DeviceState.UNKNOWN },
        });
        break;

      default:
        break;
    }
  }
}

function defaultPriority(command: CommandType): number {
  switch (command) {
    case CommandType.WIPE_DEVICE:
    case CommandType.REVOKE_SESSION:
    case CommandType.FORCE_LOGOUT:
      return 100;
    case CommandType.LOCK_DEVICE:
      return 90;
    case CommandType.UNLOCK_DEVICE:
      return 80;
    default:
      return 10;
  }
}
