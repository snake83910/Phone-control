import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { ApiClient } from '../src/lib/api';
import { parseConfig } from '../src/lib/config';
import {
  ADMIN_EXTRAS,
  EXTRA,
  buildPayload,
  payloadJson,
  renderPng,
} from '@phone-control/provisioning-payload';

/**
 * Chaîne complète, contre une API réelle.
 *
 * C'est la vérification la plus forte possible **sans téléphone** : le jeton
 * émis par l'API traverse la charge utile, l'image PNG, un décodeur QR
 * indépendant, puis revient à l'API par la route d'enrôlement. Si le badge
 * d'un chauffeur doit un jour ouvrir une session sur ce terminal, c'est ce
 * trajet-là qui aura dû fonctionner.
 *
 * **Ce test écrit dans la base** : il crée un téléphone et consomme un jeton.
 * Il ne s'exécute donc que si on le demande explicitement, et jamais en
 * intégration continue, où aucune base n'est disponible pour cet outil.
 *
 *     PC_E2E_API_URL=http://localhost:3001/api \
 *     PC_E2E_ADMIN_EMAIL=exploitation@transports-demo.local \
 *     PC_E2E_ADMIN_PASSWORD='...' \
 *     pnpm --filter @phone-control/provisioning test enrollment-e2e
 *
 * Ce qu'il ne prouve pas : qu'Android accepte cette charge utile. Seul un
 * terminal réinitialisé le dira.
 */

const apiUrl = process.env.PC_E2E_API_URL;
const email = process.env.PC_E2E_ADMIN_EMAIL;
const password = process.env.PC_E2E_ADMIN_PASSWORD;

const configured = Boolean(apiUrl && email && password);
const maybe = configured ? describe : describe.skip;

maybe('enrôlement de bout en bout', () => {
  const config = parseConfig({
    api: { baseUrl: apiUrl ?? 'http://localhost:3001/api', email: email ?? 'x@y.fr' },
    provisioning: {
      packageName: 'com.phonecontrol',
      adminComponent: 'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
      signatureChecksum: 'Dz5DmDwIO7i3ciXbErOmiMsfZMQy6geTGUDdwKZB8zg',
      serverUrl: `${apiUrl ?? 'http://localhost:3001/api'}/`,
    },
  });

  it('du jeton émis au téléphone enrôlé, en passant par le QR code', async () => {
    const client = new ApiClient(config.api.baseUrl);
    await client.login(config.api.email, password as string);

    // Étiquette unique : le test doit pouvoir être rejoué.
    const assetTag = `E2E-${Date.now().toString(36).toUpperCase()}`;
    const device = await client.createDevice({ assetTag });
    const issued = await client.createEnrollmentToken(device.id);

    const payload = buildPayload(config.provisioning, { enrollmentToken: issued.token });
    const png = await renderPng(payloadJson(payload));

    // Relecture par un décodeur qui ne partage rien avec l'encodeur.
    const image = PNG.sync.read(png);
    const decoded = jsQR(Uint8ClampedArray.from(image.data), image.width, image.height);
    expect(decoded).not.toBeNull();

    const scanned = JSON.parse((decoded as { data: string }).data);
    const bundle = scanned[EXTRA.ADMIN_EXTRAS_BUNDLE] as Record<string, string>;
    expect(bundle[ADMIN_EXTRAS.ENROLLMENT_TOKEN]).toBe(issued.token);

    const response = await fetch(`${config.api.baseUrl}/v1/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentToken: bundle[ADMIN_EXTRAS.ENROLLMENT_TOKEN],
        serialNumber: 'E2E-SANS-MATERIEL',
        manufacturer: 'verification',
        model: 'sans-materiel',
        androidVersion: '14',
        appVersion: '1.0.0',
        // Faux, et c'est le point : le serveur doit accepter un appareil qui
        // déclare ne PAS être Device Owner, et le signaler comme tel.
        deviceOwnerActive: false,
      }),
    });

    expect(response.status).toBe(200);
    const enrolled = (await response.json()) as Record<string, unknown>;
    expect(enrolled.assetTag).toBe(assetTag);
    expect(typeof enrolled.accessToken).toBe('string');
    expect(typeof enrolled.offlineKey).toBe('string');

    // Le jeton est à usage unique : la seconde tentative doit être refusée.
    const replay = await fetch(`${config.api.baseUrl}/v1/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentToken: bundle[ADMIN_EXTRAS.ENROLLMENT_TOKEN],
        deviceOwnerActive: false,
      }),
    });
    expect(replay.status).toBe(401);
  }, 60_000);
});
