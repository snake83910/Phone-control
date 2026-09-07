import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { EXTRA, maskToken, payloadJson, qrMatrix } from '@phone-control/provisioning-payload';
import { buildManifest, writeArtifacts, type DeviceArtifact } from '../src/lib/outputs';
import { buildSheet, type LabelData } from '../src/lib/sheet';

const TOKEN = 'ETK-ABCD2345-EFGH6789';

const artifact = (assetTag: string): DeviceArtifact => ({
  assetTag,
  deviceId: '0195e9f0-0000-7000-8000-000000000001',
  depotName: 'Lyon Est',
  kioskMode: 'KIOSK',
  token: TOKEN,
  expiresAt: new Date('2026-09-12T08:00:00Z'),
  payload: {
    [EXTRA.COMPONENT_NAME]: 'com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver',
    [EXTRA.SIGNATURE_CHECKSUM]: 'Dz5DmDwIO7i3ciXbErOmiMsfZMQy6geTGUDdwKZB8zg',
    [EXTRA.ADMIN_EXTRAS_BUNDLE]: {
      enrollmentToken: TOKEN,
      serverUrl: 'https://api.exemple.fr/api/',
    },
  },
});

/** Étiquette telle que la planche la reçoit, produite depuis un livrable. */
const label = (assetTag: string): LabelData => {
  const source = artifact(assetTag);
  return {
    assetTag: source.assetTag,
    depotName: source.depotName,
    kioskMode: source.kioskMode,
    expiresAt: source.expiresAt,
    maskedToken: maskToken(source.token),
    payload: payloadJson(source.payload),
  };
};

describe('planche à imprimer', () => {
  it('produit un PDF valide', async () => {
    const pdf = await buildSheet([label('TEL-001')], { generatedAt: new Date() });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
  });

  it('répartit les étiquettes sur plusieurs pages', async () => {
    const labels = Array.from({ length: 7 }, (_, index) => label(`TEL-00${index + 1}`));
    const pdf = await buildSheet(labels, { labelsPerPage: 6 });
    const pages = pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? [];

    expect(pages.length).toBe(2);
  });

  it("n'écrit jamais le jeton en clair sur l'étiquette", async () => {
    const pdf = await buildSheet([label('TEL-001')]);

    // Le jeton est dans le QR code — c'est inévitable — mais pas en toutes
    // lettres à côté, lisible par-dessus l'épaule.
    expect(pdf.toString('latin1')).not.toContain('ABCD2345');
  });

  /**
   * Le QR de la planche est dessiné en vectoriel, module par module. Un décodeur
   * ne peut pas relire un PDF, mais le nombre de rectangles tracés doit
   * correspondre au nombre de modules sombres : un code inversé, vide ou tronqué
   * se verrait immédiatement.
   */
  it('trace exactement un rectangle par module sombre', async () => {
    const pdf = await buildSheet([label('TEL-001')]);
    const rectangles = (contentStreams(pdf).match(/ re\b/g) ?? []).length;

    const matrix = qrMatrix(label('TEL-001').payload);
    let dark = 0;
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) if (matrix.isDark(x, y)) dark++;
    }

    // Les modules sombres, plus le trait de découpe de l'étiquette.
    expect(rectangles).toBe(dark + 1);
  });
});

describe('livrables d’une campagne', () => {
  it('écrit les QR codes, les charges utiles, la planche et le manifeste', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcprov-out-'));
    const written = await writeArtifacts(directory, [artifact('TEL-001'), artifact('TEL-002')]);

    expect(written.qrCodes).toHaveLength(2);
    expect(written.payloads).toHaveLength(2);
    expect(readdirSync(join(directory, 'qr')).sort()).toEqual(['TEL-001.png', 'TEL-002.png']);
    expect(readFileSync(written.sheet).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('pose un .gitignore : ce répertoire ne doit jamais entrer dans Git', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcprov-out-'));
    await writeArtifacts(directory, [artifact('TEL-001')]);

    expect(readFileSync(join(directory, '.gitignore'), 'utf8')).toContain('*');
  });

  it('écrit un manifeste sans aucun jeton en clair', () => {
    const manifest = buildManifest([artifact('TEL-001')]);

    expect(manifest).toContain('TEL-001');
    expect(manifest).toContain('6789');
    expect(manifest).not.toContain('ABCD2345');
  });
});

/** Concatène les flux de contenu du PDF, décompressés. */
function contentStreams(pdf: Buffer): string {
  const streams: string[] = [];
  const marker = Buffer.from('stream');
  let index = pdf.indexOf(marker);

  while (index >= 0) {
    let start = index + marker.length;
    if (pdf[start] === 0x0d) start++;
    if (pdf[start] === 0x0a) start++;

    const end = pdf.indexOf(Buffer.from('endstream'), start);
    if (end < 0) break;

    try {
      streams.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      // Flux non compressé ou non déflaté (police embarquée) : sans intérêt ici.
    }
    index = pdf.indexOf(marker, end);
  }

  return streams.join('\n');
}
