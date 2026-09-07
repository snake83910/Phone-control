import { createGunzip, type Gunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Décompression des corps de requête envoyés en gzip.
 *
 * Les téléphones compressent les lots de synchronisation au-delà de quatre
 * kilo-octets (docs/05 §4). Un lot de cinq cents positions est du JSON très
 * répétitif : la compression y gagne beaucoup, et ce gain se paie en données
 * mobiles réelles, sur des terminaux qui roulent toute la journée.
 *
 * Écrit à la main plutôt qu'ajouté en dépendance : quinze lignes contre un
 * greffon dont on n'utiliserait qu'une fonction sur trois. Le crochet
 * `preParsing` est le point prévu par Fastify — il substitue le flux avant que
 * le corps ne soit lu, donc sans jamais matérialiser le corps compressé.
 *
 * **Enregistré depuis un module, et non depuis `main.ts`.** La raison est
 * pratique : les tests d'intégration construisent l'application sans passer par
 * `main.ts`. Un enregistrement fait là-bas serait absent des tests, et la
 * compression ne serait vérifiée nulle part — exactement le genre d'écart qui
 * se découvre en production.
 */
@Injectable()
export class GzipRequestSupport implements OnModuleInit {
  private readonly logger = new Logger(GzipRequestSupport.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!instance || typeof instance.addHook !== 'function') {
      this.logger.warn(
        "Adaptateur HTTP inattendu : les corps gzip ne seront pas décompressés.",
      );
      return;
    }

    registerGzipRequestSupport(instance);
  }
}

type PreParsingDone = (error: Error | null, stream?: Readable) => void;

export function registerGzipRequestSupport(fastify: FastifyInstance): void {
  fastify.addHook(
    'preParsing',
    (request: FastifyRequest, _reply: unknown, payload: Readable, done: PreParsingDone) => {
      if (request.headers['content-encoding'] !== 'gzip') {
        done(null, payload);
        return;
      }

      const gunzip: Gunzip & { receivedEncodedLength?: number } = createGunzip();

      // Fastify compare la longueur reçue à l'en-tête `Content-Length`. Le flux
      // décompressé est plus long que ce que l'en-tête annonce : sans ce
      // compteur, chaque lot compressé serait rejeté en 400 pour incohérence de
      // taille. C'est la propriété que le crochet `preParsing` impose de tenir
      // à jour, et elle explique un échec autrement incompréhensible.
      let encodedLength = 0;
      payload.on('data', (chunk: Buffer | string) => {
        encodedLength += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        gunzip.receivedEncodedLength = encodedLength;
      });

      // Sans cette propagation, une erreur de décompression laisserait la
      // requête suspendue jusqu'au délai d'attente au lieu de répondre.
      payload.on('error', (error: Error) => gunzip.destroy(error));


      done(null, payload.pipe(gunzip));
    },
  );
}
