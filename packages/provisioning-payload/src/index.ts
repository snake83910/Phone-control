/**
 * Charge utile du QR code de provisioning Device Owner.
 *
 * Ce paquet existe parce que **deux programmes fabriquent le même QR code** :
 * l'outil d'atelier (`tools/provisioning`, pour un parc entier) et le dashboard
 * (pour un téléphone à la fois, depuis sa fiche). Deux constructions du même
 * format finiraient par diverger — et la divergence ne se verrait qu'au moment
 * où un téléphone neuf refuse de se configurer.
 *
 * Ce qui est ici est donc la définition unique du format : les clés Android,
 * les règles de validité, le contrat des extras, et le rendu du code.
 *
 * S'y ajoute la **lecture du bloc de signature d'un APK**. Elle vivait dans
 * l'atelier tant que lui seul en avait besoin ; le serveur en a besoin à son
 * tour, pour calculer l'empreinte d'un APK déposé avant de le déployer sur la
 * flotte. Deux lectures indépendantes du même format finiraient par diverger,
 * et la divergence ne se verrait qu'au moment où un téléphone refuserait une
 * installation légitime — ou en accepterait une qu'il aurait dû refuser.
 *
 * Ce qui n'y est pas, et reste propre à l'atelier : la planche PDF, le fichier
 * de parc, la voie ADB.
 */

export { signatureChecksum, isValidChecksum } from './checksum';
export {
  readSigningCertificate,
  readCertificateFile,
  describeCertificate,
  type SigningCertificate,
  type CertificateSummary,
} from './apk';
export { ProvisioningError } from './errors';
export {
  provisioningProfileSchema,
  wifiSchema,
  WIFI_SECURITY_TYPES,
  type ProvisioningProfile,
} from './profile';
export {
  ADMIN_EXTRAS,
  EXTRA,
  QR_COMFORT_BYTES,
  QR_MAX_BYTES,
  buildPayload,
  payloadJson,
  validatePayload,
  type BuildOptions,
  type ProvisioningPayload,
  type ValidationResult,
} from './payload';
export {
  qrMatrix,
  recommendedPrintSizeMm,
  renderPng,
  renderSvg,
  type ErrorCorrectionLevel,
  type QrMatrix,
} from './qr';
export { maskSecret, maskToken, redactPayload } from './redact';
