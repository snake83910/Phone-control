import { createHash } from 'node:crypto';

/**
 * Empreinte de signature attendue par Android.
 *
 * Isolée du reste de la lecture d'APK — qui, elle, touche au système de
 * fichiers — pour que le dashboard puisse valider une empreinte sans embarquer
 * un analyseur d'archives.
 *
 * `PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` porte le SHA-256 du
 * **certificat de signature**, en base64 **URL-safe et sans remplissage**.
 * L'alphabet et le remplissage sont la source d'erreur la plus fréquente : une
 * empreinte en base64 classique (`+`, `/`, `=`) traverse le lecteur de QR code
 * puis est rejetée silencieusement à la vérification.
 */
export function signatureChecksum(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url');
}

/** Une empreinte valide fait 43 caractères et se décode en 32 octets. */
export function isValidChecksum(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return Buffer.from(value, 'base64url').length === 32;
}
