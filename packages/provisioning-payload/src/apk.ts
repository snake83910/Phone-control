import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ProvisioningError } from './errors';
import { signatureChecksum } from './checksum';

/**
 * Extraction du certificat de signature d'un APK, et calcul de l'empreinte
 * attendue par `PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM`.
 *
 * Pourquoi ce code plutôt qu'un appel à `apksigner` : l'atelier n'a pas
 * forcément le SDK Android installé, et une empreinte fausse produit un échec
 * de provisioning au message inutile (« Impossible de configurer l'appareil »).
 * Autant la calculer ici, et la vérifier.
 *
 * **Ce qui est calculé est l'empreinte du CERTIFICAT DE SIGNATURE, pas celle du
 * fichier APK.** C'est ce qui permet à un QR code imprimé de rester valable
 * quand l'application est mise à jour : la clé de signature, elle, ne change
 * pas. L'empreinte du fichier existe aussi côté Android
 * (`PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM`) mais elle oblige à réimprimer
 * toutes les planches à chaque version — on ne l'utilise pas.
 */

/** Bloc de signature APK : identifiants des schémas, du plus récent au plus ancien. */
const SIGNATURE_SCHEME_IDS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 0x1b93ad61, name: 'v3.1' },
  { id: 0xf05368c0, name: 'v3' },
  { id: 0x7109871a, name: 'v2' },
];

const APK_SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;

/** Taille maximale du commentaire de fin d'archive ZIP (champ sur 16 bits). */
const MAX_ZIP_COMMENT = 0xffff;

export interface SigningCertificate {
  /** Certificat X.509 brut, en DER. */
  der: Buffer;
  /** Schéma de signature d'où il a été lu. */
  scheme: string;
}

/**
 * Lecteur à bornes vérifiées.
 *
 * Un APK tronqué ou tout autre fichier renommé en `.apk` ne doit pas produire
 * une exception `RangeError` illisible, mais un message qui dit quoi faire.
 */
class Reader {
  private offset: number;

  constructor(
    private readonly buffer: Buffer,
    start = 0,
    private readonly end = buffer.length,
  ) {
    this.offset = start;
  }

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.end - this.offset;
  }

  uint32(): number {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  /** Une longueur sur 64 bits : refusée si elle dépasse l'entier sûr. */
  uint64(): number {
    this.require(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProvisioningError('Longueur de bloc aberrante : fichier corrompu.');
    }
    return Number(value);
  }

  bytes(length: number): Buffer {
    this.require(length);
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** Sous-lecteur borné à `length` octets, consommés du lecteur courant. */
  slice(length: number): Reader {
    this.require(length);
    const child = new Reader(this.buffer, this.offset, this.offset + length);
    this.offset += length;
    return child;
  }

  /** Séquence préfixée de sa longueur sur 32 bits, convention du bloc APK. */
  lengthPrefixed(): Reader {
    return this.slice(this.uint32());
  }

  private require(length: number): void {
    if (length < 0 || this.offset + length > this.end) {
      throw new ProvisioningError(
        "Structure de signature incohérente : l'APK est tronqué ou n'en est pas un.",
        'Vérifiez le fichier, puis reconstruisez-le avec `./gradlew :app:assembleRelease`.',
      );
    }
  }
}

/** Position du « End of Central Directory » ZIP, cherchée depuis la fin. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - MAX_ZIP_COMMENT - 22);
  for (let index = buffer.length - 22; index >= minimum; index--) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  throw new ProvisioningError(
    "Ce fichier n'est pas une archive ZIP : aucun en-tête de fin d'archive trouvé.",
    "Un APK est un ZIP. Vérifiez le chemin fourni à --apk.",
  );
}

/**
 * Certificat contenu dans un bloc de signeurs v2 ou v3.
 *
 * Les deux schémas partagent le même début de structure : la séquence des
 * signeurs, puis pour chaque signeur ses données signées, qui commencent par
 * les condensats puis les certificats. Le premier certificat est celui du
 * signeur — c'est lui qu'Android compare à l'empreinte du QR code.
 */
function certificateFromSigners(block: Reader): Buffer {
  const signers = block.lengthPrefixed();
  if (signers.remaining === 0) {
    throw new ProvisioningError('Bloc de signature vide : aucun signeur déclaré.');
  }

  const signer = signers.lengthPrefixed();
  const signedData = signer.lengthPrefixed();

  signedData.lengthPrefixed(); // condensats, non utilisés ici
  const certificates = signedData.lengthPrefixed();

  if (certificates.remaining === 0) {
    throw new ProvisioningError('Aucun certificat dans les données signées.');
  }

  const certificate = certificates.lengthPrefixed();
  return Buffer.from(certificate.bytes(certificate.remaining));
}

/** Noms des fichiers de signature v1 (JAR), pour un message d'erreur utile. */
function listV1SignatureEntries(buffer: Buffer, centralDirectoryOffset: number): string[] {
  const names: string[] = [];
  let offset = centralDirectoryOffset;

  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === CENTRAL_DIRECTORY_SIGNATURE) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (/^META-INF\/.+\.(RSA|DSA|EC)$/i.test(name)) names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

/** Lit le certificat de signature d'un APK signé en schéma v2, v3 ou v3.1. */
export function readSigningCertificate(apkPath: string): SigningCertificate {
  let buffer: Buffer;
  try {
    buffer = readFileSync(apkPath);
  } catch {
    throw new ProvisioningError(`Fichier introuvable ou illisible : ${apkPath}`);
  }

  const eocd = findEndOfCentralDirectory(buffer);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);

  const magicStart = centralDirectoryOffset - APK_SIG_BLOCK_MAGIC.length;
  const magic =
    magicStart >= 0 ? buffer.toString('latin1', magicStart, centralDirectoryOffset) : '';

  if (magic !== APK_SIG_BLOCK_MAGIC) {
    const v1 = listV1SignatureEntries(buffer, centralDirectoryOffset);
    throw new ProvisioningError(
      v1.length > 0
        ? `Cet APK n'est signé qu'en schéma v1 (JAR) : ${v1.join(', ')}.`
        : "Cet APK ne porte aucune signature : il n'a pas été signé.",
      v1.length > 0
        ? 'Le schéma v1 n’est pas lu par cet outil. Utilisez : ' +
          'apksigner verify --print-certs-pem <apk> > cert.pem, puis --cert cert.pem.'
        : 'Signez l’APK avant de calculer son empreinte (`./gradlew :app:assembleRelease`).',
    );
  }

  const trailer = new Reader(buffer, centralDirectoryOffset - 24, centralDirectoryOffset);
  const declaredSize = trailer.uint64();
  const blockStart = centralDirectoryOffset - declaredSize - 8;

  if (blockStart < 0) {
    throw new ProvisioningError('Bloc de signature APK incohérent : taille hors limites.');
  }

  const header = new Reader(buffer, blockStart, blockStart + 8);
  if (header.uint64() !== declaredSize) {
    throw new ProvisioningError(
      'Bloc de signature APK incohérent : les deux tailles déclarées diffèrent.',
    );
  }

  // Les paires (longueur, identifiant, valeur) du bloc, indexées par schéma.
  const pairs = new Map<number, Reader>();
  const pairsReader = new Reader(buffer, blockStart + 8, centralDirectoryOffset - 24);
  while (pairsReader.remaining > 12) {
    const length = pairsReader.uint64();
    const pair = pairsReader.slice(length);
    const id = pair.uint32();
    if (!pairs.has(id)) pairs.set(id, pair);
  }

  for (const scheme of SIGNATURE_SCHEME_IDS) {
    const pair = pairs.get(scheme.id);
    if (!pair) continue;
    return { der: certificateFromSigners(pair), scheme: scheme.name };
  }

  throw new ProvisioningError(
    'Bloc de signature présent, mais aucun schéma v2/v3 reconnu.',
    'Vérifiez la configuration de signature du module app.',
  );
}

/** Lit un certificat depuis un fichier PEM ou DER. */
export function readCertificateFile(path: string): Buffer {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw new ProvisioningError(`Certificat introuvable ou illisible : ${path}`);
  }

  try {
    // X509Certificate accepte les deux formats et refuse tout le reste :
    // il sert ici autant de convertisseur que de contrôle de validité.
    return new X509Certificate(content).raw;
  } catch {
    throw new ProvisioningError(
      `Ce fichier n'est pas un certificat X.509 lisible : ${path}`,
      'Formats acceptés : PEM (-----BEGIN CERTIFICATE-----) ou DER binaire.',
    );
  }
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  sha256Hex: string;
  checksum: string;
  /** Vrai si le certificat expire dans moins de 25 ans (exigence des magasins). */
  expiresSoon: boolean;
  expired: boolean;
}

const TWENTY_FIVE_YEARS_MS = 25 * 365.25 * 24 * 3600 * 1000;

export function describeCertificate(der: Buffer, now = new Date()): CertificateSummary {
  const certificate = new X509Certificate(der);
  const validTo = new Date(certificate.validTo);

  return {
    subject: certificate.subject.replace(/\n/g, ', '),
    issuer: certificate.issuer.replace(/\n/g, ', '),
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    sha256Hex: createHash('sha256').update(der).digest('hex'),
    checksum: signatureChecksum(der),
    expired: validTo.getTime() < now.getTime(),
    expiresSoon: validTo.getTime() - now.getTime() < TWENTY_FIVE_YEARS_MS,
  };
}
