import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Processus worker autonome.
 *
 * Même code, même configuration, même contexte multi-entreprises que l'API,
 * mais sans adaptateur HTTP : rien à exposer, donc rien à attaquer.
 *
 * Déploiement recommandé au-delà d'une instance d'API :
 *   - API      : WORKER_ENABLED=false  (n'exécute aucune tâche planifiée)
 *   - worker   : WORKER_ENABLED=true   (un seul processus, `node dist/worker-main.js`)
 *
 * Même si plusieurs workers étaient démarrés par erreur, le verrou Redis
 * garantit qu'une seule instance travaille à un instant donné.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  if (process.env.WORKER_ENABLED === 'false') {
    logger.error(
      'WORKER_ENABLED=false : ce processus n’exécuterait aucune tâche. Arrêt.',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  logger.log(
    'Worker démarré : verrouillage planifié, surveillance de la flotte, entretien et purge.',
  );
}

void bootstrap();
