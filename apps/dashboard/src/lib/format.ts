/**
 * Formatage d'affichage.
 *
 * Toutes les dates arrivent en UTC. Elles sont affichées dans le fuseau du
 * navigateur, sauf mention contraire : pour les règles de dépôt, l'API renvoie
 * déjà l'heure locale du dépôt, car c'est elle qui fait foi et non celle de
 * l'administrateur, qui peut se trouver ailleurs.
 */

const dateTime = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

const timeOnly = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' });

const dateOnly = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateTime.format(new Date(value));
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return timeOnly.format(new Date(value));
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return dateOnly.format(new Date(value));
}

/** « il y a 3 min », « il y a 2 h ». L'ancienneté est souvent l'information utile. */
export function formatAge(value: string | Date | null | undefined): string {
  if (!value) return 'jamais';
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.round(ms / 60_000);

  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;

  const days = Math.round(hours / 24);
  if (days < 31) return `il y a ${days} j`;

  return formatDate(value);
}

export function formatCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string {
  if (latitude == null || longitude == null) return '—';
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function fullName(
  person: { firstName: string; lastName: string } | null | undefined,
): string {
  return person ? `${person.firstName} ${person.lastName}` : '—';
}

const DEVICE_STATE_LABELS: Record<string, string> = {
  UNKNOWN: 'Inconnu',
  LOCKED: 'Verrouillé',
  ACTIVE: 'Actif',
  RETURNED: 'Retourné',
  LOCKING: 'Verrouillage',
};

export function deviceStateLabel(state: string): string {
  return DEVICE_STATE_LABELS[state] ?? state;
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  AFTER_RETURN_EXIT: 'Sortie après retour',
  UNKNOWN_BADGE: 'Badge inconnu',
  UNAUTHORIZED_USER: 'Utilisateur non autorisé',
  DEVICE_OFFLINE: 'Téléphone hors ligne',
  LOCATION_DISABLED: 'Localisation désactivée',
  SECURITY_EVENT: 'Événement de sécurité',
  DEVICE_TAMPERING: 'Altération suspectée',
  BATTERY_LOW: 'Batterie faible',
  NOT_RETURNED: 'Non retourné',
  LOCK_FAILED: 'Échec de verrouillage',
};

export function alertTypeLabel(type: string): string {
  return ALERT_TYPE_LABELS[type] ?? type;
}

const SECURITY_TYPE_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: 'Connexion réussie',
  LOGIN_FAILED: 'Échec de connexion',
  UNKNOWN_BADGE: 'Badge inconnu',
  UNAUTHORIZED_USER: 'Utilisateur non autorisé',
  ENTER_DEPOT: 'Entrée au dépôt',
  EXIT_DEPOT: 'Sortie du dépôt',
  AFTER_RETURN_EXIT: 'Sortie après retour',
  LOCK_DEVICE: 'Verrouillage',
  UNLOCK_DEVICE: 'Déverrouillage',
  DEVICE_OFFLINE: 'Hors ligne',
  LOCATION_DISABLED: 'Localisation désactivée',
  COMMAND_FAILED: 'Échec de commande',
  ROOT_DETECTED: 'Root détecté',
  DEBUGGER_ATTACHED: 'Débogueur attaché',
  ADB_ENABLED: 'ADB activé',
  CLOCK_TAMPERING: 'Horloge manipulée',
  MOCK_LOCATION: 'Position simulée',
  KIOSK_EXIT_ATTEMPT: 'Tentative de sortie du kiosque',
  DEVICE_OWNER_LOST: 'Device Owner perdu',
  APP_INTEGRITY_FAILED: 'Intégrité applicative en échec',
  SESSION_STARTED: 'Session ouverte',
  SESSION_ENDED: 'Session terminée',
};

export function securityTypeLabel(type: string): string {
  return SECURITY_TYPE_LABELS[type] ?? type;
}

const SCAN_RESULT_LABELS: Record<string, string> = {
  SUCCESS: 'Accès autorisé',
  UNKNOWN_BADGE: 'Badge inconnu',
  BADGE_INACTIVE: 'Badge inactif',
  BADGE_REVOKED: 'Badge révoqué',
  USER_INACTIVE: 'Chauffeur désactivé',
  DEVICE_UNKNOWN: 'Téléphone inconnu',
  DEVICE_NOT_ENROLLED: 'Téléphone non enrôlé',
  DEVICE_REVOKED: 'Téléphone révoqué',
  DEVICE_NOT_AUTHORIZED: 'Téléphone non autorisé',
  COMPANY_MISMATCH: 'Entreprise incohérente',
  RATE_LIMITED: 'Trop de tentatives',
  OFFLINE_GRANTED: 'Accordé hors ligne',
  OFFLINE_DENIED: 'Refusé hors ligne',
};

export function scanResultLabel(result: string): string {
  return SCAN_RESULT_LABELS[result] ?? result;
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super administrateur',
  COMPANY_ADMIN: 'Administrateur entreprise',
  DEPOT_ADMIN: 'Responsable de dépôt',
  VIEWER: 'Lecture seule',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
