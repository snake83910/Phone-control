import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantIsolationError } from '../prisma/tenant-extension';
import { BadgeNormalizationError } from '../crypto/badge-hash.service';
import { ScheduleConfigError } from '../rules/schedule';
import { TenantContext } from './tenant-context';

/**
 * Erreur de décompression zlib.
 *
 * Node les identifie par un code commençant par `Z_` (`Z_DATA_ERROR`,
 * `Z_BUF_ERROR`…). On ne teste pas la classe : elle n'est pas exportée, et le
 * code est le contrat documenté.
 */
function isDecompressionError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const code = (exception as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('Z_');
}

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  correlationId: string;
  timestamp: string;
}

/**
 * Filtre global. Deux exigences :
 *  - ne jamais laisser fuir un détail interne (message Prisma, chemin de
 *    fichier, valeur de badge) vers un client ;
 *  - toujours renvoyer le correlationId, pour qu'un utilisateur puisse citer
 *    un identifiant que l'on retrouve dans les journaux (docs/02 §62).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status: (code: number) => { send: (body: unknown) => void };
    }>();

    const correlationId = TenantContext.get()?.correlationId ?? 'n/a';
    const { status, message, error } = this.describe(exception);

    if (status >= 500) {
      this.logger.error(
        `[${correlationId}] ${error}: ${String(
          exception instanceof Error ? exception.stack : exception,
        )}`,
      );
    } else {
      this.logger.warn(`[${correlationId}] ${status} ${error}: ${String(message)}`);
    }

    const body: ErrorBody = {
      statusCode: status,
      message,
      error,
      correlationId,
      timestamp: new Date().toISOString(),
    };

    response.status(status).send(body);
  }

  private describe(exception: unknown): {
    status: number;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ?? exception.message);
      return {
        status: exception.getStatus(),
        message,
        error: exception.name,
      };
    }

    // Une violation de cloisonnement se présente au client comme une ressource
    // inexistante : révéler « cet objet existe mais pas chez vous » serait déjà
    // une fuite d'information.
    if (exception instanceof TenantIsolationError) {
      return {
        status: HttpStatus.NOT_FOUND,
        message: 'Ressource introuvable.',
        error: 'NotFound',
      };
    }

    // Corps compressé illisible : envoi interrompu, proxy qui tronque, lot
    // corrompu en route. C'est une faute du client — le téléphone n'a qu'à
    // rejouer son lot — et non une panne du serveur. Les confondre ferait
    // sonner la supervision pour un incident réseau ordinaire.
    if (isDecompressionError(exception)) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Corps de requête illisible : décompression impossible.',
        error: 'BadRequest',
      };
    }

    if (exception instanceof BadgeNormalizationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'Code-barres invalide.',
        error: 'BadRequest',
      };
    }

    if (exception instanceof ScheduleConfigError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: exception.message,
        error: 'BadRequest',
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            message: 'Cette valeur existe déjà.',
            error: 'Conflict',
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            message: 'Ressource introuvable.',
            error: 'NotFound',
          };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            message: 'Référence invalide.',
            error: 'BadRequest',
          };
        default:
          break;
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Erreur interne.',
      error: 'InternalServerError',
    };
  }
}
