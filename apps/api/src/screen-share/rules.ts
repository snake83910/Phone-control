/**
 * Règles du partage d'écran.
 *
 * Module **pur** : aucune dépendance à Nest, à Prisma ni à l'horloge système.
 * Il se relit et se teste seul, et c'est délibéré — ces règles sont le seul
 * garde-fou entre une assistance et une surveillance, et elles doivent pouvoir
 * être vérifiées par quelqu'un qui ne lit pas le reste du serveur.
 *
 * Trois invariants, qu'aucun chemin de code ne doit pouvoir contourner :
 *
 * 1. **Aucune image sans accord.** Une capture n'est acceptée que dans l'état
 *    `ACCEPTED`. Ni avant la réponse du chauffeur, ni après la fin.
 *
 * 2. **Toute séance se termine.** L'échéance ferme la séance sans que personne
 *    n'intervienne. Un partage qui dure tant qu'on ne l'arrête pas est une
 *    surveillance permanente déguisée en oubli.
 *
 * 3. **Un état terminal est définitif.** On ne « rouvre » pas un refus : il
 *    faut une nouvelle demande, donc une nouvelle décision du chauffeur.
 */

export type ScreenShareState =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'REFUSED'
  | 'ENDED_BY_DRIVER'
  | 'ENDED_BY_ADMIN'
  | 'EXPIRED'
  | 'FAILED';

export type ScreenShareEvent =
  /** Le chauffeur accepte. */
  | 'DRIVER_ACCEPTS'
  /** Le chauffeur refuse. */
  | 'DRIVER_REFUSES'
  /** Le chauffeur coupe le partage en cours. */
  | 'DRIVER_STOPS'
  /** L'exploitation coupe le partage, ou annule sa demande. */
  | 'ADMIN_STOPS'
  /** Le téléphone n'a pas pu démarrer la capture. */
  | 'CAPTURE_FAILED'
  /** L'échéance est atteinte. */
  | 'DEADLINE_REACHED';

/** États depuis lesquels plus rien ne peut arriver. */
export const TERMINAL_STATES: readonly ScreenShareState[] = [
  'REFUSED',
  'ENDED_BY_DRIVER',
  'ENDED_BY_ADMIN',
  'EXPIRED',
  'FAILED',
];

export function isTerminal(state: ScreenShareState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface TransitionResult {
  /** État après l'événement. Identique à l'état d'entrée si rien ne change. */
  state: ScreenShareState;
  /** L'événement a-t-il été retenu ? */
  applied: boolean;
  /** Pourquoi il ne l'a pas été. Destiné au message d'erreur et au journal. */
  refusal?: string;
}

/**
 * Applique un événement à une séance.
 *
 * Le refus est explicite plutôt que silencieux : un « accepter » arrivant sur
 * une séance déjà expirée doit produire une explication, pas une capture.
 */
export function transition(
  state: ScreenShareState,
  event: ScreenShareEvent,
): TransitionResult {
  if (isTerminal(state)) {
    // Rejouer l'arrêt d'une séance déjà terminée n'est pas une faute : c'est
    // ce qui arrive quand une réponse HTTP se perd. On ne change rien, et on
    // ne s'en plaint pas non plus.
    if (event === 'ADMIN_STOPS' || event === 'DRIVER_STOPS' || event === 'DEADLINE_REACHED') {
      return { state, applied: false };
    }
    return {
      state,
      applied: false,
      refusal: `La séance est déjà terminée (${state}).`,
    };
  }

  switch (event) {
    case 'DEADLINE_REACHED':
      return { state: 'EXPIRED', applied: true };

    case 'ADMIN_STOPS':
      return { state: 'ENDED_BY_ADMIN', applied: true };

    case 'CAPTURE_FAILED':
      return { state: 'FAILED', applied: true };

    case 'DRIVER_ACCEPTS':
      if (state !== 'REQUESTED') {
        return {
          state,
          applied: false,
          refusal: 'Un accord ne peut porter que sur une demande en attente.',
        };
      }
      return { state: 'ACCEPTED', applied: true };

    case 'DRIVER_REFUSES':
      if (state !== 'REQUESTED') {
        return {
          state,
          applied: false,
          refusal: 'Un refus ne peut porter que sur une demande en attente.',
        };
      }
      return { state: 'REFUSED', applied: true };

    case 'DRIVER_STOPS':
      if (state !== 'ACCEPTED') {
        return {
          state,
          applied: false,
          refusal: 'Aucun partage en cours à interrompre.',
        };
      }
      return { state: 'ENDED_BY_DRIVER', applied: true };
  }
}

/**
 * Une image peut-elle être acceptée ?
 *
 * L'échéance est vérifiée ici, et pas seulement à la transition : sans cela,
 * une séance dont personne ne déclenche la fermeture continuerait à recevoir
 * des captures. C'est l'invariant n°2, appliqué à l'endroit exact où il compte.
 */
export function acceptsFrames(
  state: ScreenShareState,
  expiresAt: Date,
  now: Date,
): { ok: boolean; refusal?: string } {
  if (state !== 'ACCEPTED') {
    return {
      ok: false,
      refusal:
        state === 'REQUESTED'
          ? "Le chauffeur n'a pas encore répondu."
          : `Le partage n'est plus en cours (${state}).`,
    };
  }
  if (now.getTime() >= expiresAt.getTime()) {
    return { ok: false, refusal: 'La durée maximale du partage est atteinte.' };
  }
  return { ok: true };
}

/**
 * La demande attend-elle encore une réponse ?
 *
 * Le téléphone s'en sert pour décider s'il affiche l'écran de demande. Une
 * demande périmée ne doit pas surgir devant un chauffeur qui roule depuis :
 * il répondrait à une question que plus personne ne pose.
 */
export function awaitsDecision(
  state: ScreenShareState,
  expiresAt: Date,
  now: Date,
): boolean {
  return state === 'REQUESTED' && now.getTime() < expiresAt.getTime();
}
