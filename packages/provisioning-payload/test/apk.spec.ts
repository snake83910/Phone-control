import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeCertificate,
  readCertificateFile,
  readSigningCertificate,
} from '../src/apk';
import {
  ProvisioningError,
  isValidChecksum,
  signatureChecksum,
} from '../src/index';

/**
 * Ces tests s'appuient sur une valeur de référence externe.
 *
 * L'empreinte attendue n'a pas été produite par ce code : elle vient de
 * `apksigner verify --print-certs`, l'outil officiel du SDK Android. Un test
 * qui compare une implémentation à elle-même ne prouve rien ; celui-ci ancre le
 * parseur sur ce qu'Android considère être le certificat de signature.
 */
const DEBUG_CERT_SHA256 = '0f3e43983c083bb8b77225db12b3a688cb1f64c432ea07931940ddc0a641f338';
const DEBUG_CERT_CHECKSUM = 'Dz5DmDwIO7i3ciXbErOmiMsfZMQy6geTGUDdwKZB8zg';

const FIXTURES = join(__dirname, 'fixtures');
const DER = join(FIXTURES, 'debug-signing-cert.der');
const PEM = join(FIXTURES, 'debug-signing-cert.pem');

// L'APK n'est pas versionné : il n'existe que si le module Android a été construit.
const APK = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);

describe('empreinte de signature', () => {
  it('accepte un certificat en DER et en PEM, et produit la même empreinte', () => {
    const fromDer = readCertificateFile(DER);
    const fromPem = readCertificateFile(PEM);

    expect(fromDer.equals(fromPem)).toBe(true);
    expect(signatureChecksum(fromDer)).toBe(DEBUG_CERT_CHECKSUM);
  });

  it('produit une empreinte en base64 URL-safe, sans remplissage', () => {
    const checksum = signatureChecksum(readCertificateFile(DER));

    expect(checksum).toHaveLength(43);
    expect(checksum).not.toContain('=');
    expect(checksum).not.toContain('+');
    expect(checksum).not.toContain('/');
    expect(isValidChecksum(checksum)).toBe(true);
  });

  it('refuse ce qui ressemble à une empreinte sans en être une', () => {
    // Base64 classique de la même valeur : même octets, alphabet différent.
    const standard = Buffer.from(DEBUG_CERT_CHECKSUM, 'base64url').toString('base64');

    expect(isValidChecksum(standard)).toBe(false);
    expect(isValidChecksum('')).toBe(false);
    expect(isValidChecksum('trop-court')).toBe(false);
    expect(isValidChecksum(`${DEBUG_CERT_CHECKSUM}A`)).toBe(false);
  });

  it('décrit le certificat et repère une expiration proche', () => {
    const summary = describeCertificate(readCertificateFile(DER));

    expect(summary.sha256Hex).toBe(DEBUG_CERT_SHA256);
    expect(summary.subject).toContain('Android Debug');
    expect(summary.expired).toBe(false);

    // La clé de debug d'Android est valable 30 ans à compter de sa création :
    // vue depuis 2045, elle expire « bientôt ».
    const vueDeLoin = describeCertificate(readCertificateFile(DER), new Date('2045-01-01'));
    expect(vueDeLoin.expiresSoon).toBe(true);
  });

  it("refuse un fichier qui n'est pas un certificat", () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcprov-'));
    const path = join(directory, 'pas-un-certificat.pem');
    writeFileSync(path, 'bonjour');

    expect(() => readCertificateFile(path)).toThrow(ProvisioningError);
  });
});

describe("lecture du certificat depuis l'APK", () => {
  const available = existsSync(APK);
  const maybe = available ? it : it.skip;

  maybe('lit le certificat du bloc de signature v2/v3', () => {
    const certificate = readSigningCertificate(APK);

    expect(['v2', 'v3', 'v3.1']).toContain(certificate.scheme);
    expect(signatureChecksum(certificate.der)).toBe(DEBUG_CERT_CHECKSUM);
  });

  maybe("donne le même certificat que celui extrait à part", () => {
    expect(readSigningCertificate(APK).der.equals(readCertificateFile(DER))).toBe(true);
  });

  it('explique clairement un fichier qui n’est pas une archive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcprov-'));
    const path = join(directory, 'faux.apk');
    writeFileSync(path, Buffer.alloc(4096, 7));

    expect(() => readSigningCertificate(path)).toThrow(/archive ZIP/);
  });

  it('signale un ZIP valide mais sans signature', () => {
    // Archive ZIP vide : uniquement son en-tête de fin.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);

    const directory = mkdtempSync(join(tmpdir(), 'pcprov-'));
    const path = join(directory, 'vide.apk');
    writeFileSync(path, eocd);

    expect(() => readSigningCertificate(path)).toThrow(/aucune signature/);
  });
});
