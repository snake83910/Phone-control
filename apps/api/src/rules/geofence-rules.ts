import { DepotSchedule, isAfterReturnTime } from './schedule';

/**
 * Règles métier du geofencing, côté serveur — cf. docs/06 §4.2 et §5.
 *
 * Le serveur ne réévalue PAS la géométrie : l'appareil lui transmet des
 * transitions déjà confirmées par son moteur local (hystérésis, échantillons
 * multiples, précision). Le serveur applique la règle horaire avec SA propre
 * horloge et la configuration du dépôt à jour, et c'est lui qui fait autorité
 * en cas de divergence.
 *
 * Fonctions pures : entrée -> décision. Aucun accès base, aucun effet de bord.
 */

export type TransitionKind = 'ENTER' | 'EXIT';

export type GeofenceEventTypeName =
  | 'ENTER_DEPOT'
  | 'EXIT_DEPOT'
  | 'ENTER_DEPOT_AFTER_RETURN_TIME'
  | 'AFTER_RETURN_EXIT';

export type SessionStateName = 'ACTIVE' | 'RETURNED';

export interface GeofenceDecisionInput {
  transition: TransitionKind;
  /** Instant de la transition, tel que daté par l'appareil (UTC). */
  occurredAt: Date;
  schedule: DepotSchedule;
  /** État de la session au moment de la transition. */
  sessionState: SessionStateName;
}

export interface GeofenceDecision {
  eventType: GeofenceEventTypeName;
  nextSessionState: SessionStateName;
  /** Le téléphone doit-il être marqué comme retourné (horodatage + position) ? */
  markReturned: boolean;
  alert: {
    type: 'AFTER_RETURN_EXIT';
    severity: 'HIGH';
    title: string;
  } | null;
  /** Explication lisible, conservée dans l'événement pour le support. */
  reason: string;
}

export function evaluateGeofenceTransition(
  input: GeofenceDecisionInput,
): GeofenceDecision {
  const { transition, occurredAt, schedule, sessionState } = input;

  if (transition === 'ENTER') {
    const afterReturn = isAfterReturnTime(schedule, occurredAt);

    if (!afterReturn) {
      // Le chauffeur passe au dépôt avant l'heure de retour : c'est un simple
      // passage, pas une fin de tournée.
      return {
        eventType: 'ENTER_DEPOT',
        nextSessionState: sessionState,
        markReturned: false,
        alert: null,
        reason: "Entrée au dépôt avant l'heure de retour : aucun effet.",
      };
    }

    return {
      eventType: 'ENTER_DEPOT_AFTER_RETURN_TIME',
      nextSessionState: 'RETURNED',
      // On ne réécrit pas l'horodatage de retour si la session est déjà
      // marquée retournée : le premier retour fait foi.
      markReturned: sessionState !== 'RETURNED',
      alert: null,
      reason:
        "Entrée au dépôt après l'heure de retour : téléphone considéré comme retourné.",
    };
  }

  // transition === 'EXIT'
  if (sessionState === 'RETURNED') {
    return {
      eventType: 'AFTER_RETURN_EXIT',
      // L'alerte n'est pas un état bloquant : la session redevient ACTIVE,
      // et l'alerte reste ouverte jusqu'à acquittement (cf. docs/02 §6).
      nextSessionState: 'ACTIVE',
      markReturned: false,
      alert: {
        type: 'AFTER_RETURN_EXIT',
        severity: 'HIGH',
        title: 'Sortie du dépôt après le retour',
      },
      reason:
        'Sortie du dépôt alors que le téléphone était marqué comme retourné.',
    };
  }

  return {
    eventType: 'EXIT_DEPOT',
    nextSessionState: sessionState,
    markReturned: false,
    alert: null,
    reason: 'Sortie du dépôt en cours de tournée : aucun effet.',
  };
}

// ---------------------------------------------------------------------------
//  Classification géométrique (miroir du moteur Android)
//
//  Le serveur ne s'en sert pas pour décider, mais pour vérifier la cohérence
//  d'une transition reçue et pour alimenter les scénarios de test partagés.
// ---------------------------------------------------------------------------

export type FixClassification = 'INSIDE_CERTAIN' | 'OUTSIDE_CERTAIN' | 'UNDETERMINED';

const EARTH_RADIUS_M = 6371008.8;

/** Distance haversine en mètres entre deux positions géographiques. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Classe un point par rapport à une zone, en tenant compte de son incertitude.
 *
 *   d + a  <  R        -> certainement dedans
 *   d - a  >  R + H    -> certainement dehors
 *   sinon              -> indéterminé, AUCUNE transition
 *
 * C'est cette troisième branche qui empêche le faux positif décrit dans la
 * spécification : 50 m hors zone avec 100 m de précision reste indéterminé.
 */
export function classifyFix(params: {
  distanceMeters: number;
  accuracyMeters: number;
  radiusMeters: number;
  hysteresisMeters: number;
}): FixClassification {
  const { distanceMeters: d, accuracyMeters: a, radiusMeters: r, hysteresisMeters: h } =
    params;

  if (d + a < r) return 'INSIDE_CERTAIN';
  if (d - a > r + h) return 'OUTSIDE_CERTAIN';
  return 'UNDETERMINED';
}
