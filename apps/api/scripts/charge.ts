/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DeviceEnrollmentStatus, DeviceState } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeviceTokenService } from '../src/auth/device-token.service';
import { TenantContext } from '../src/common/tenant-context';
import { newId } from '../src/common/ids';

/**
 * Banc de charge.
 *
 * Il ne mesure pas « combien de requêtes par seconde », chiffre qui ne veut rien
 * dire sans le matériel qui le produit. Il mesure **ce qui compte pour ce
 * système** :
 *
 *  1. Le scan de badge, parce qu'un chauffeur attend devant l'écran. Une
 *     seconde de trop, cent fois par jour, et le produit est jugé lent.
 *  2. La remontée d'un lot de synchronisation, parce que deux mille téléphones
 *     le font toutes les quinze minutes, et parce qu'un lot de fin de journée
 *     contient des milliers de positions.
 *  3. Le heartbeat, parce que c'est la requête la plus fréquente du parc.
 *
 * L'API est montée **dans ce processus** : les chiffres excluent donc la pile
 * réseau et le proxy inverse. C'est délibéré — on cherche le coût du code et de
 * la base, pas celui d'un lien local. Un banc de charge sur l'infrastructure
 * réelle reste à faire, et il donnera des nombres différents.
 *
 *   pnpm --filter @phone-control/api charge
 *   pnpm --filter @phone-control/api charge -- --devices 500 --batch 200
 */

interface Options {
  devices: number;
  batch: number;
  concurrency: number;
  rounds: number;
}

function parseOptions(argv: string[]): Options {
  const read = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    devices: read('devices', 200),
    batch: read('batch', 100),
    concurrency: read('concurrency', 32),
    rounds: read('rounds', 1),
  };
}

/** Statistiques d'une série de mesures, en millisecondes. */
function summarize(samples: number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Exécute `total` tâches avec au plus `concurrency` en vol.
 *
 * Écrit à la main : un `Promise.all` sur deux mille requêtes mesurerait la
 * capacité de Node à saturer une file, pas le temps de réponse du serveur sous
 * une charge tenable.
 */
async function withConcurrency<T>(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<number[]> {
  const durations: number[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      const started = performance.now();
      await task(index);
      durations.push(performance.now() - started);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return durations;
}

const format = (label: string, stats: ReturnType<typeof summarize>, elapsedMs: number): string => {
  const perSecond = (stats.count / (elapsedMs / 1000)).toFixed(0);
  return (
    `${label.padEnd(34)} ${String(stats.count).padStart(6)} req  ` +
    `p50 ${stats.p50.toFixed(0).padStart(5)} ms  ` +
    `p95 ${stats.p95.toFixed(0).padStart(5)} ms  ` +
    `p99 ${stats.p99.toFixed(0).padStart(5)} ms  ` +
    `max ${stats.max.toFixed(0).padStart(5)} ms  ` +
    `${perSecond.padStart(6)} req/s`
  );
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const stage = (label: string): void =>
    console.log(`… ${label} (${new Date().toISOString()})`);

  stage('démarrage de l’application');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 8 * 1024 * 1024 }),
    { logger: false },
  );
  stage('application créée');
  await app.init();
  stage('application initialisée');
  await app.getHttpAdapter().getInstance().ready();
  stage('serveur prêt');

  const prisma = app.get(PrismaService);
  const deviceTokens = app.get(DeviceTokenService);

  console.log('');
  console.log('Banc de charge — Phone Control');
  console.log(
    `${options.devices} téléphones · lots de ${options.batch} événements · ` +
      `${options.concurrency} requêtes simultanées`,
  );
  console.log('');

  // --- Préparation ---------------------------------------------------------
  stage('préparation du jeu de charge');
  const suffix = Date.now().toString(36);
  const prepared = await TenantContext.system(async () => {
    const company = await prisma.raw.company.create({
      data: { id: newId(), name: `Charge ${suffix}`, slug: `charge-${suffix}` },
    });
    const depot = await prisma.raw.depot.create({
      data: {
        id: newId(),
        companyId: company.id,
        code: 'CHARGE',
        name: 'Dépôt de charge',
        latitude: 45.75,
        longitude: 4.85,
        timezone: 'Europe/Paris',
      },
    });

    const devices = [];
    for (let index = 0; index < options.devices; index++) {
      const device = await prisma.raw.device.create({
        data: {
          id: newId(),
          companyId: company.id,
          depotId: depot.id,
          assetTag: `CHG-${suffix}-${index}`,
          enrollmentStatus: DeviceEnrollmentStatus.ENROLLED,
          state: DeviceState.LOCKED,
        },
      });
      const tokens = await deviceTokens.issue(device.id, company.id);
      devices.push({ id: device.id, token: tokens.accessToken });
    }

    return { company, depot, devices };
  });

  stage(`${prepared.devices.length} téléphones prêts`);

  const inject = (
    url: string,
    token: string,
    payload: unknown,
  ): Promise<{ statusCode: number }> =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
    });

  const device = (index: number) => prepared.devices[index % prepared.devices.length];

  // --- Heartbeat -----------------------------------------------------------
  {
    const total = options.devices * options.rounds;
    const started = performance.now();
    const durations = await withConcurrency(total, options.concurrency, async (index) => {
      const target = device(index);
      const response = await inject('/v1/devices/heartbeat', target.token, {
        deviceId: target.id,
        battery: 40 + (index % 60),
        charging: false,
        network: 'mobile',
        gps: true,
      });
      if (response.statusCode !== 200) {
        throw new Error(`heartbeat ${response.statusCode}`);
      }
    });
    console.log(format('Heartbeat', summarize(durations), performance.now() - started));
  }

  // --- Lots de synchronisation ---------------------------------------------
  {
    const total = options.devices * options.rounds;
    const started = performance.now();
    const durations = await withConcurrency(total, options.concurrency, async (index) => {
      const target = device(index);
      const base = Date.now() - options.batch * 1000;
      const events = Array.from({ length: options.batch }, (_, position) => ({
        eventId: randomUUID(),
        seq: position + 1,
        kind: 'LOCATION',
        occurredAt: new Date(base + position * 1000).toISOString(),
        latitude: 45.75 + position * 0.0001,
        longitude: 4.85 + position * 0.0001,
        accuracyMeters: 12,
        speedMps: 8,
      }));

      const response = await inject('/v1/sync/events', target.token, {
        deviceId: target.id,
        events,
      });
      if (response.statusCode !== 200) {
        throw new Error(`sync ${response.statusCode}`);
      }
    });

    const elapsed = performance.now() - started;
    const stats = summarize(durations);
    console.log(format(`Synchronisation (${options.batch} év.)`, stats, elapsed));
    console.log(
      ''.padEnd(34) +
        `        ${(stats.count * options.batch).toLocaleString('fr-FR')} événements insérés, ` +
        `${((stats.count * options.batch) / (elapsed / 1000)).toFixed(0)} év./s`,
    );
  }

  // --- Scan de badge -------------------------------------------------------
  {
    // Badges inconnus : c'est le chemin le plus coûteux — recherche par
    // empreinte, journalisation, alerte de sécurité — et celui qu'un attaquant
    // sollicite. Le mesurer sur le refus donne la borne haute.
    const total = Math.min(options.devices, 100) * options.rounds;
    const started = performance.now();
    const durations = await withConcurrency(total, Math.min(options.concurrency, 8), async (index) => {
      const target = device(index);
      const response = await inject('/v1/auth/barcode', target.token, {
        deviceId: target.id,
        barcode: String(90000000 + index),
      });
      // 200 (refus métier) comme 429 (limitation de débit) sont des réponses
      // normales ici : la limitation fait partie du produit.
      if (![200, 401, 429].includes(response.statusCode)) {
        throw new Error(`barcode ${response.statusCode}`);
      }
    });
    console.log(format('Scan de badge (refus)', summarize(durations), performance.now() - started));
  }

  console.log('');

  // --- Nettoyage -----------------------------------------------------------
  await TenantContext.system(() =>
    prisma.raw.company.delete({ where: { id: prepared.company.id } }),
  );
  console.log('Jeu de charge supprimé.');
  console.log('');

  await app.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
