import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Type MIME d'un APK. C'est celui que le dashboard envoie. */
export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';

/**
 * Reception d'un APK, ecrit directement sur disque.
 *
 * **Le fichier n'est jamais materialise en memoire.** Un APK pese couramment
 * quarante mega-octets ; le mettre dans un tampon, c'est offrir a n'importe quel
 * appelant authentifie de faire allouer quarante mega-octets au serveur, autant
 * de fois qu'il le souhaite.
 *
 * Le corps est donc lu en flux, ecrit au fur et a mesure, et son empreinte
 * calculee dans le meme passage. La borne de taille est appliquee **pendant**
 * la lecture : au premier octet de trop, le flux est coupe et le fichier
 * partiel supprime. Recevoir cent cinquante mega-octets pour ensuite les
 * refuser reviendrait a n'avoir pose aucune borne.
 *
 * Ecrit a la main plutot qu'avec `@fastify/multipart` : il n'y a qu'un fichier
 * et aucun champ de formulaire. Le corps EST l'APK, ce qui rend l'envoi trivial
 * cote navigateur et evite une dependance dont on n'utiliserait rien.
 */
export interface UploadedApk {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/** Erreur d'envoi : une situation que l'operateur peut corriger. */
export class ApkUploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApkUploadError';
  }
}

@Injectable()
export class ApkUploadSupport implements OnModuleInit {
  private readonly logger = new Logger(ApkUploadSupport.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!instance || typeof instance.addContentTypeParser !== 'function') {
      this.logger.warn(
        "Adaptateur HTTP inattendu : le dépôt d'APK ne sera pas disponible.",
      );
      return;
    }

    // Le corps n'est pas analysé : il est laissé tel quel, sous forme de flux,
    // pour que le contrôleur l'écrive lui-même. Fastify n'a pas de mode
    // « ne touche à rien » ; on le lui fabrique.
    instance.addContentTypeParser(
      APK_CONTENT_TYPE,
      (_request, payload, done) => done(null, payload),
    );
  }
}

/**
 * Ecrit le corps de la requete dans `destination`, en calculant son empreinte.
 *
 * Le fichier partiel est supprime en cas d'echec : un APK tronque qui resterait
 * sur disque finirait un jour par etre servi a un telephone.
 */
export async function storeUploadedApk(
  request: FastifyRequest,
  destination: string,
  maxBytes: number,
): Promise<UploadedApk> {
  const source = request.raw as unknown as Readable;
  const hash = createHash('sha256');
  let sizeBytes = 0;

  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        callback(
          new ApkUploadError(
            `Fichier trop volumineux : la limite est de ${Math.round(maxBytes / 1024 / 1024)} Mo.`,
            413,
          ),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await mkdir(dirname(destination), { recursive: true });

  try {
    await pipeline(source, measure, createWriteStream(destination));
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }

  if (sizeBytes === 0) {
    await unlink(destination).catch(() => undefined);
    throw new ApkUploadError('Fichier vide.', 400);
  }

  return { path: destination, sha256: hash.digest('hex'), sizeBytes };
}
