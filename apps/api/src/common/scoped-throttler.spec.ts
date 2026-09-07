import { subjectOfBearerToken } from './scoped-throttler.guard';

/**
 * Compteur de la limitation de débit.
 *
 * Ce test existe à cause d'un défaut trouvé au banc de charge : compter par
 * adresse IP faisait partager un même quota à tous les téléphones d'un même
 * opérateur mobile. Sur le terrain, cela se serait manifesté par des terminaux
 * « qui ne remontent plus », de façon intermittente et incompréhensible.
 *
 * La règle est simple et vaut d'être verrouillée : **une requête authentifiée
 * compte pour son porteur, une requête anonyme pour son adresse.**
 */
describe('Compteur de limitation de débit', () => {
  const token = (payload: Record<string, unknown>): string =>
    [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'signature-non-verifiee',
    ].join('.');

  it('distingue deux appareils', () => {
    const first = subjectOfBearerToken(`Bearer ${token({ sub: 'device-1', typ: 'device' })}`);
    const second = subjectOfBearerToken(`Bearer ${token({ sub: 'device-2', typ: 'device' })}`);

    expect(first).toBe('device:device-1');
    expect(second).toBe('device:device-2');
    expect(first).not.toBe(second);
  });

  it('ne confond pas un appareil et un administrateur de même identifiant', () => {
    const identifiant = '0195e9f0-0000-7000-8000-000000000001';

    expect(subjectOfBearerToken(`Bearer ${token({ sub: identifiant, typ: 'device' })}`)).not.toBe(
      subjectOfBearerToken(`Bearer ${token({ sub: identifiant, typ: 'admin' })}`),
    );
  });

  it('retombe sur l’adresse IP quand il n’y a pas de jeton', () => {
    // C'est là que la limitation protège vraiment : elle empêche une attaque
    // par force brute de faire travailler Argon2 des milliers de fois.
    expect(subjectOfBearerToken(undefined)).toBeUndefined();
    expect(subjectOfBearerToken('')).toBeUndefined();
    expect(subjectOfBearerToken('Basic abc')).toBeUndefined();
  });

  it('retombe sur l’adresse IP devant un jeton malformé', () => {
    expect(subjectOfBearerToken('Bearer pas-un-jwt')).toBeUndefined();
    expect(subjectOfBearerToken('Bearer a.b')).toBeUndefined();
    expect(subjectOfBearerToken('Bearer a.!!!.c')).toBeUndefined();
    expect(subjectOfBearerToken(`Bearer ${token({ pas_de_sujet: 1 })}`)).toBeUndefined();
    expect(subjectOfBearerToken(`Bearer ${token({ sub: '' })}`)).toBeUndefined();
  });

  it('accepte un jeton sans champ de type', () => {
    expect(subjectOfBearerToken(`Bearer ${token({ sub: 'x' })}`)).toBe('jwt:x');
  });
});
