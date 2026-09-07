import { createVerify, generateKeyPairSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  DisabledPushTransport,
  FcmTransport,
  buildFcmMessage,
  buildJwtAssertion,
  createPushTransport,
  serviceAccountSchema,
  type ServiceAccount,
} from './fcm';

/**
 * Réveil FCM.
 *
 * **Aucun de ces tests ne parle à Google** : il n'existe pas de projet Firebase
 * pour ce système. Ce qu'ils établissent est ce qui peut l'être depuis ce poste,
 * et c'est déjà beaucoup — l'assertion JWT est vérifiée *avec la clé publique*
 * correspondante, donc sa signature est réellement valide, et le message envoyé
 * a la forme exacte que documente Google.
 *
 * Ce qu'ils n'établissent pas : que Google accepte l'assertion et délivre le
 * message. Cela demande le projet Firebase — prérequis P4 de docs/08.
 */
describe('Réveil FCM', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const account: ServiceAccount = serviceAccountSchema.parse({
    project_id: 'phone-control-demo',
    client_email: 'fcm@phone-control-demo.iam.gserviceaccount.com',
    private_key: privateKey,
  });

  describe('assertion JWT', () => {
    const now = 1_757_000_000;
    const assertion = buildJwtAssertion(account, now);

    const [header, claims, signature] = assertion.split('.');
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

    it('porte une signature RS256 réellement valable', () => {
      // Le point qui compte : la signature est vérifiée avec la clé publique.
      // Un test qui se contenterait de comparer des chaînes ne dirait rien.
      const valid = createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature, 'base64url'));

      expect(valid).toBe(true);
    });

    it('déclare l’algorithme et le type attendus', () => {
      expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    });

    it('demande la bonne portée au bon destinataire', () => {
      expect(decode(claims)).toMatchObject({
        iss: account.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        iat: now,
      });
    });

    it('expire dans l’heure, comme Google l’exige', () => {
      const { iat, exp } = decode(claims);
      expect(exp - iat).toBe(3600);
    });
  });

  describe('message', () => {
    const message = buildFcmMessage('jeton-du-telephone', {
      reason: 'LOCK_DEVICE',
      commandId: 'c-1',
    });
    const inner = (message.message as Record<string, unknown>);

    it('est un data message, jamais une notification', () => {
      // Rien ne doit s'afficher sur l'écran d'un chauffeur.
      expect(inner.notification).toBeUndefined();
      expect(inner.data).toEqual({ reason: 'LOCK_DEVICE', commandId: 'c-1' });
    });

    it('ne transporte aucune instruction exécutable', () => {
      // Le message dit « viens voir », pas « verrouille ». Un message FCM
      // falsifié ne peut donc rien commander : le téléphone se synchronise
      // ensuite par le canal authentifié.
      const encoded = JSON.stringify(message);
      expect(encoded).not.toContain('payload');
      expect(Object.keys(inner.data as object).sort()).toEqual(['commandId', 'reason']);
    });

    it('part en priorité haute et périme vite', () => {
      // Un réveil livré deux heures plus tard arriverait après la
      // synchronisation périodique : il n'a plus d'intérêt.
      expect(inner.android).toEqual({ priority: 'HIGH', ttl: '600s' });
    });

    it('omet le commandId quand il n’y en a pas', () => {
      const wake = buildFcmMessage('jeton', { reason: 'SYNC' });
      expect((wake.message as { data: object }).data).toEqual({ reason: 'SYNC' });
    });
  });

  describe('transport', () => {
    const okToken = () =>
      new Response(JSON.stringify({ access_token: 'jeton-acces', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    it('échange une assertion contre un jeton, puis envoie le message', async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return String(url).includes('oauth2')
          ? okToken()
          : new Response('{}', { status: 200 });
      }) as typeof fetch;

      const transport = new FcmTransport(account, fetcher);
      const result = await transport.send('jeton-telephone', { reason: 'LOCK_DEVICE' });

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe(
        'https://fcm.googleapis.com/v1/projects/phone-control-demo/messages:send',
      );
      expect((calls[1].init?.headers as Record<string, string>).authorization).toBe(
        'Bearer jeton-acces',
      );
    });

    it('réutilise le jeton d’accès au lieu d’en redemander un', async () => {
      let tokenCalls = 0;
      const fetcher = (async (url: string | URL | Request) => {
        if (String(url).includes('oauth2')) {
          tokenCalls += 1;
          return okToken();
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const transport = new FcmTransport(account, fetcher);
      await transport.send('a', { reason: 'X' });
      await transport.send('b', { reason: 'Y' });

      expect(tokenCalls).toBe(1);
    });

    it('traite un jeton de téléphone rejeté comme un cycle de vie, pas une panne', async () => {
      const fetcher = (async (url: string | URL | Request) =>
        String(url).includes('oauth2') ? okToken() : new Response('{}', { status: 404 })) as typeof fetch;

      const result = await new FcmTransport(account, fetcher).send('perime', { reason: 'X' });

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('404');
    });

    it('ne lève jamais, même quand le réseau tombe', async () => {
      const fetcher = (async () => {
        throw new Error('réseau injoignable');
      }) as typeof fetch;

      const result = await new FcmTransport(account, fetcher).send('x', { reason: 'X' });

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('réseau injoignable');
    });
  });

  describe('construction depuis la configuration', () => {
    const logger = new Logger('test');

    it('sans clé de service, le transport est désactivé', () => {
      expect(createPushTransport(undefined, logger)).toBeInstanceOf(DisabledPushTransport);
      expect(createPushTransport('   ', logger)).toBeInstanceOf(DisabledPushTransport);
    });

    it('une clé illisible ne fait pas échouer le démarrage', () => {
      // L'API doit démarrer même avec une clé fautive : le sondage périodique
      // suffit à faire fonctionner le parc.
      const transport = createPushTransport('{ pas du json', logger);

      expect(transport.configured).toBe(false);
    });

    it('une clé incomplète est refusée plutôt qu’acceptée à moitié', () => {
      const transport = createPushTransport(
        JSON.stringify({ project_id: 'x', client_email: 'a@b.fr' }),
        logger,
      );

      expect(transport.configured).toBe(false);
    });

    it('une clé complète active le transport', () => {
      const transport = createPushTransport(JSON.stringify(account), logger);

      expect(transport.configured).toBe(true);
      expect(transport.name).toBe('fcm');
    });
  });

  describe('transport désactivé', () => {
    it('dit pourquoi il n’envoie rien', async () => {
      const result = await new DisabledPushTransport().send();

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('sondage périodique');
    });
  });
});
