import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { buildPayload, payloadJson } from '../src/payload';
import { provisioningProfileSchema } from '../src/profile';
import { qrMatrix, recommendedPrintSizeMm, renderPng, renderSvg } from '../src/qr';
import { maskSecret, maskToken, redactPayload } from '../src/redact';
import { EXTRA } from '../src/payload';

/**
 * Le test qui compte vraiment : **le QR code produit se relit-il ?**
 *
 * Le reste de la suite vérifie qu'on écrit les bonnes valeurs. Ici on vérifie
 * qu'un décodeur indépendant, qui n'a rien à voir avec la bibliothèque
 * d'encodage, retrouve exactement la charge utile attendue. C'est l'unique
 * moyen, sans téléphone, de savoir que la chaîne tient debout.
 *
 * Ce que ce test ne prouve pas, et qu'aucun test ne prouvera : qu'Android
 * accepte cette charge utile, que l'imprimante rende le code lisible, que la
 * caméra d'un terminal neuf le déchiffre à 20 cm. Cela demande du matériel.
 */

const TOKEN = 'ETK-ABCD2345-EFGH6789';

const profile = provisioningProfileSchema.parse({
  packageName: 'com.phonecontrol',
  adminComponent: 'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
  signatureChecksum: 'Dz5DmDwIO7i3ciXbErOmiMsfZMQy6geTGUDdwKZB8zg',
  apkDownloadUrl: 'https://exemple.fr/provisioning/phonecontrol-1.0.0.apk',
  serverUrl: 'https://api.exemple.fr/api/',
  locale: 'fr_FR',
  timeZone: 'Europe/Paris',
  wifi: { ssid: 'ATELIER-FLOTTE', securityType: 'WPA' },
});

const payload = buildPayload(profile, {
  enrollmentToken: TOKEN,
  wifiPassword: 'cle-atelier-2026',
});

function decode(png: Buffer): string | null {
  const image = PNG.sync.read(png);
  const result = jsQR(Uint8ClampedArray.from(image.data), image.width, image.height);
  return result ? result.data : null;
}

describe('aller-retour du QR code', () => {
  it('se relit à l’identique, jusqu’au dernier caractère du jeton', async () => {
    const json = payloadJson(payload);
    const decoded = decode(await renderPng(json));

    expect(decoded).toBe(json);
    expect(JSON.parse(decoded as string)).toEqual(payload);
  });

  it('reste lisible aux quatre niveaux de correction', async () => {
    const json = payloadJson(payload);

    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      expect(decode(await renderPng(json, level))).toBe(json);
    }
  });

  it('reste lisible à petite échelle, comme sur une étiquette imprimée', async () => {
    const json = payloadJson(payload);

    expect(decode(await renderPng(json, 'M', 3))).toBe(json);
  });

  it('produit aussi un SVG, pour le rendu dans le dashboard', async () => {
    const json = payloadJson(payload);
    const svg = await renderSvg(json);

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    // Le jeton est encodé dans les modules, jamais écrit en clair dans le SVG.
    expect(svg).not.toContain('ABCD2345');

    // Le SVG décrit bien LE MÊME code que la matrice : sa zone de dessin vaut
    // le nombre de modules plus la marge silencieuse de quatre modules de
    // chaque côté. Un SVG rendu à partir d'une autre charge utile, ou tronqué,
    // n'aurait pas cette taille.
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(viewBox).not.toBeNull();
    expect(Number(viewBox![1])).toBe(qrMatrix(json).size + 8);
    expect(viewBox![1]).toBe(viewBox![2]);
  });
});

describe('mesure du code', () => {
  it('donne une matrice carrée et une taille d’impression conseillée', () => {
    const matrix = qrMatrix(payloadJson(payload));

    expect(matrix.size).toBeGreaterThan(20);
    expect(matrix.version).toBeGreaterThan(0);
    expect(recommendedPrintSizeMm(matrix)).toBeGreaterThanOrEqual(30);
  });

  it('refuse une charge utile qu’aucun QR code ne peut contenir', () => {
    expect(() => qrMatrix('x'.repeat(5000))).toThrow(/Impossible d'encoder/);
  });
});

describe('masquage', () => {
  it('laisse quatre caractères pour rapprocher une étiquette d’une ligne', () => {
    const masked = maskToken(TOKEN);

    expect(masked.startsWith('ETK-')).toBe(true);
    expect(masked.endsWith('6789')).toBe(true);
    expect(masked).not.toContain('ABCD2345');
    expect(masked).not.toContain('EFGH');
  });

  it('ne révèle rien d’un mot de passe absent', () => {
    expect(maskSecret(undefined)).toBe('(absent)');
    expect(maskSecret('abcdef')).toMatch(/6 caractères/);
  });

  it('masque le jeton et le mot de passe Wi-Fi d’une charge utile', () => {
    const redacted = JSON.stringify(redactPayload(payload));

    expect(redacted).not.toContain('cle-atelier-2026');
    expect(redacted).not.toContain('ABCD2345');
    expect(redacted).toContain('6789');
    expect(JSON.parse(redacted)[EXTRA.COMPONENT_NAME]).toBe(profile.adminComponent);
  });
});
