import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, hkdfSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { BadgeHashService } from './badge-hash.service';

/**
 * Parité cryptographique avec l'application Android.
 *
 * Les mêmes vecteurs sont vérifiés par la suite JUnit du module `core-rules`
 * (`BadgeHmacParityTest`). Ils garantissent qu'un badge accepté en ligne le
 * sera aussi hors ligne : le téléphone recalcule l'empreinte avec sa propre clé
 * Keystore, et doit tomber exactement sur celle que le serveur lui a envoyée.
 *
 * Une divergence — base64 au lieu de base64url, préfixe de version oublié,
 * HKDF implémenté différemment — ne se verrait sinon qu'un soir de panne
 * réseau, sur le terrain.
 */
describe('Parité du hachage des badges (serveur ↔ Android)', () => {
  const vectors = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../packages/state-machine-spec/scenarios/badge-hash-vectors.json',
      ),
      'utf8',
    ),
  ) as {
    hashVersion: number;
    masterKey: string;
    pepper: string;
    deviceId: string;
    deviceKeyBase64: string;
    vectors: Array<{
      normalized: string;
      serverHash: string;
      deviceHash: string;
    }>;
  };

  function serviceWith(pepper: string, masterKey: string): BadgeHashService {
    const config = {
      getOrThrow: (key: string) =>
        key === 'BADGE_HMAC_PEPPER' ? pepper : masterKey,
      get: () => vectors.hashVersion,
    } as unknown as ConfigService;
    return new BadgeHashService(config);
  }

  it('produit les empreintes serveur de référence', () => {
    const service = serviceWith(vectors.pepper, vectors.masterKey);

    for (const vector of vectors.vectors) {
      expect(service.hash(vector.normalized, true).toString('base64url')).toBe(
        vector.serverHash,
      );
    }
  });

  it('dérive la clé d’appareil attendue', () => {
    const service = serviceWith(vectors.pepper, vectors.masterKey);
    const derived = service.deriveDeviceKey(vectors.deviceId);

    expect(derived.toString('base64')).toBe(vectors.deviceKeyBase64);
  });

  it('produit les empreintes propres à l’appareil de référence', () => {
    const service = serviceWith(vectors.pepper, vectors.masterKey);
    const deviceKey = service.deriveDeviceKey(vectors.deviceId);

    for (const vector of vectors.vectors) {
      expect(service.deviceScopedHash(deviceKey, vector.normalized)).toBe(
        vector.deviceHash,
      );
    }
  });

  it('le format haché inclut la version : deux versions ne se confondent pas', () => {
    const pepper = Buffer.from(vectors.pepper, 'utf8');
    const v1 = createHmac('sha256', pepper).update('v1:14557719').digest('base64url');
    const v2 = createHmac('sha256', pepper).update('v2:14557719').digest('base64url');

    // Sans le préfixe de version, une rotation de la normalisation produirait
    // silencieusement les mêmes empreintes qu'avant.
    expect(v1).not.toBe(v2);
    expect(v1).toBe(vectors.vectors[0].serverHash);
  });

  it('la dérivation dépend de l’appareil, pas seulement de la clé maîtresse', () => {
    const master = Buffer.from(vectors.masterKey, 'utf8');
    const info = Buffer.from('offline-badge-v1', 'utf8');

    const a = Buffer.from(
      hkdfSync('sha256', master, Buffer.from('appareil-a', 'utf8'), info, 32),
    );
    const b = Buffer.from(
      hkdfSync('sha256', master, Buffer.from('appareil-b', 'utf8'), info, 32),
    );

    // C'est ce qui rend inexploitable ailleurs une liste extraite d'un
    // téléphone volé.
    expect(a.equals(b)).toBe(false);
  });
});
