/**
 * Charge les variables d'environnement avant tout import applicatif.
 * Les tests d'intégration s'exécutent sur la base de développement locale
 * (docker compose up -d postgres redis).
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '..', '.env') });

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

// Les tâches planifiées sont testées en appelant les jobs directement, avec un
// instant maîtrisé. Les laisser se déclencher toutes les minutes pendant la
// suite créerait des alertes parasites sur les appareils des autres tests.
process.env.WORKER_ENABLED = 'false';
