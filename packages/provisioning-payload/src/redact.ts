/**
 * Masquage des secrets destinés à l'affichage.
 *
 * Un jeton d'enrôlement est un secret porteur : quiconque le lit peut enrôler
 * un téléphone dans l'entreprise, tant qu'il n'a pas été consommé. Il n'a donc
 * rien à faire dans un journal d'atelier, une capture d'écran ou un ticket.
 *
 * Il n'apparaît en clair qu'à deux endroits, et c'est délibéré : dans le QR
 * code lui-même, et dans le fichier JSON produit à côté. Les deux sont écrits
 * dans un répertoire de sortie ignoré par Git.
 */

const MASK = '•'; // point médian, plus lisible qu'une étoile sur une planche imprimée

/**
 * `ETK-ABCD2345-EFGH6789` devient `ETK-••••••••-••••6789`.
 *
 * Les quatre derniers caractères restent visibles : ils suffisent à rapprocher
 * une ligne de journal d'un téléphone précis sans permettre de rejouer le jeton.
 */
export function maskToken(token: string): string {
  if (!token) return '';
  const visible = 4;
  if (token.length <= visible) return MASK.repeat(token.length);

  const prefixMatch = /^([A-Z]{2,6}-)/.exec(token);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const body = token.slice(prefix.length);
  const tail = body.slice(-visible);
  const masked = body
    .slice(0, -visible)
    .replace(/[^-]/g, MASK);

  return `${prefix}${masked}${tail}`;
}

/** Masque toute valeur secrète dont on ne veut montrer que l'existence. */
export function maskSecret(value: string | undefined | null): string {
  if (value === undefined || value === null || value === '') return '(absent)';
  return `${MASK.repeat(8)} (${value.length} caractères)`;
}

/**
 * Copie d'une charge utile de provisioning sûre à afficher : le jeton
 * d'enrôlement et le mot de passe Wi-Fi y sont masqués.
 *
 * Le reste — composant, empreinte de signature, URL — n'est pas secret : ces
 * valeurs sont publiques par construction, puisqu'elles voyagent en clair dans
 * un QR code que n'importe qui peut photographier sur le dos d'un téléphone.
 */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...payload };

  const wifiKey = 'android.app.extra.PROVISIONING_WIFI_PASSWORD';
  if (typeof copy[wifiKey] === 'string') {
    copy[wifiKey] = maskSecret(copy[wifiKey] as string);
  }

  const bundleKey = 'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE';
  const bundle = copy[bundleKey];
  if (bundle && typeof bundle === 'object') {
    const redacted: Record<string, unknown> = { ...(bundle as Record<string, unknown>) };
    if (typeof redacted.enrollmentToken === 'string') {
      redacted.enrollmentToken = maskToken(redacted.enrollmentToken);
    }
    copy[bundleKey] = redacted;
  }

  return copy;
}
