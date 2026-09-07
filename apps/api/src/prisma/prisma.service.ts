import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTenantExtension } from './tenant-extension';

function buildScopedClient(base: PrismaClient) {
  return base.$extends(createTenantExtension(base));
}

/** Client Prisma appliquant automatiquement le cloisonnement multi-entreprises. */
export type ScopedPrismaClient = ReturnType<typeof buildScopedClient>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Client brut, sans filtre d'entreprise.
   * Réservé aux migrations, à l'amorçage, aux tâches système et aux requêtes
   * d'authentification qui doivent précéder l'établissement du contexte
   * (recherche d'un administrateur par e-mail, d'un appareil par identifiant).
   * Tout autre usage est un contournement du cloisonnement.
   */
  readonly raw: PrismaClient;

  /** Client à utiliser par défaut dans les services métier. */
  readonly db: ScopedPrismaClient;

  constructor() {
    this.raw = new PrismaClient({
      log:
        process.env.NODE_ENV === 'development'
          ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
          : ['warn', 'error'],
    });
    this.db = buildScopedClient(this.raw);
  }

  async onModuleInit(): Promise<void> {
    await this.raw.$connect();
    this.logger.log('Connexion PostgreSQL établie');
  }

  async onModuleDestroy(): Promise<void> {
    await this.raw.$disconnect();
  }

  /**
   * Vide toutes les tables métier. Réservé aux tests d'intégration ; refuse de
   * s'exécuter hors environnement de test.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error("truncateAll() est réservé à l'environnement de test.");
    }
    // TRUNCATE ... CASCADE sur companies suffit : tout le graphe en dépend.
    await this.raw.$executeRawUnsafe(
      'TRUNCATE TABLE companies, admins, audit_logs RESTART IDENTITY CASCADE',
    );
    await this.raw.$executeRawUnsafe('TRUNCATE TABLE location_events');
  }
}
