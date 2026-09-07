import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acceptsFrames,
  awaitsDecision,
  isTerminal,
  transition,
  type ScreenShareEvent,
  type ScreenShareState,
} from './rules';

/**
 * Machine à états du partage d'écran.
 *
 * Les cas vivent dans `packages/state-machine-spec/scenarios/screen-share.json`
 * et sont exécutés des deux côtés : ici, et par la suite JUnit du téléphone.
 * C'est le seul dispositif qui empêche les deux implémentations de diverger —
 * un téléphone qui capturerait dans un état que le serveur refuse serait
 * exactement le défaut que ce dispositif existe pour empêcher.
 */
const SPEC = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../packages/state-machine-spec/scenarios/screen-share.json',
    ),
    'utf8',
  ),
) as {
  transitions: Array<{
    name: string;
    from: ScreenShareState;
    event: ScreenShareEvent;
    to: ScreenShareState;
    applied: boolean;
  }>;
  frames: Array<{
    name: string;
    state: ScreenShareState;
    nowOffsetMs: number;
    accepted: boolean;
  }>;
  prompt: Array<{
    name: string;
    state: ScreenShareState;
    nowOffsetMs: number;
    show: boolean;
  }>;
};

const EXPIRES_AT = new Date('2026-09-06T14:00:00.000Z');
const at = (offsetMs: number) => new Date(EXPIRES_AT.getTime() + offsetMs);

describe('Partage d’écran — machine à états', () => {
  it.each(SPEC.transitions.map((t) => [t.name, t] as const))(
    '%s',
    (_name, scenario) => {
      const result = transition(scenario.from, scenario.event);
      expect(result.state).toBe(scenario.to);
      expect(result.applied).toBe(scenario.applied);
    },
  );

  it('couvre chaque état terminal', () => {
    // Un état terminal ajouté sans scénario passerait inaperçu : la machine
    // l'accepterait, et personne ne saurait ce qu'il autorise.
    for (const state of [
      'REFUSED',
      'ENDED_BY_DRIVER',
      'ENDED_BY_ADMIN',
      'EXPIRED',
      'FAILED',
    ] as ScreenShareState[]) {
      expect(isTerminal(state)).toBe(true);
    }
    expect(isTerminal('REQUESTED')).toBe(false);
    expect(isTerminal('ACCEPTED')).toBe(false);
  });

  it('ne permet à aucun événement de rouvrir un état terminal', () => {
    // Formulation générale de l'invariant n°3, indépendante des scénarios :
    // aucune combinaison ne doit ramener une séance close vers un état vivant.
    const events: ScreenShareEvent[] = [
      'DRIVER_ACCEPTS',
      'DRIVER_REFUSES',
      'DRIVER_STOPS',
      'ADMIN_STOPS',
      'CAPTURE_FAILED',
      'DEADLINE_REACHED',
    ];

    for (const state of [
      'REFUSED',
      'ENDED_BY_DRIVER',
      'ENDED_BY_ADMIN',
      'EXPIRED',
      'FAILED',
    ] as ScreenShareState[]) {
      for (const event of events) {
        const result = transition(state, event);
        expect(result.state).toBe(state);
        expect(result.applied).toBe(false);
      }
    }
  });
});

describe('Partage d’écran — acceptation des images', () => {
  it.each(SPEC.frames.map((f) => [f.name, f] as const))(
    '%s',
    (_name, scenario) => {
      const result = acceptsFrames(
        scenario.state,
        EXPIRES_AT,
        at(scenario.nowOffsetMs),
      );
      expect(result.ok).toBe(scenario.accepted);
      if (!scenario.accepted) expect(result.refusal).toBeTruthy();
    },
  );

  it('n’accepte d’image dans aucun état sauf ACCEPTED', () => {
    // Invariant n°1, énoncé exhaustivement plutôt que par l'exemple.
    for (const state of [
      'REQUESTED',
      'REFUSED',
      'ENDED_BY_DRIVER',
      'ENDED_BY_ADMIN',
      'EXPIRED',
      'FAILED',
    ] as ScreenShareState[]) {
      expect(acceptsFrames(state, EXPIRES_AT, at(-60_000)).ok).toBe(false);
    }
  });
});

describe('Partage d’écran — affichage de la demande', () => {
  it.each(SPEC.prompt.map((p) => [p.name, p] as const))(
    '%s',
    (_name, scenario) => {
      expect(
        awaitsDecision(scenario.state, EXPIRES_AT, at(scenario.nowOffsetMs)),
      ).toBe(scenario.show);
    },
  );
});
