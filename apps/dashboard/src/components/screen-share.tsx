'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { Card, EmptyState } from '@/components/ui';

export interface ScreenShareSession {
  id: string;
  deviceId: string;
  state:
    | 'REQUESTED'
    | 'ACCEPTED'
    | 'REFUSED'
    | 'ENDED_BY_DRIVER'
    | 'ENDED_BY_ADMIN'
    | 'EXPIRED'
    | 'FAILED';
  reason: string;
  expiresAt: string;
  frameCount: number;
  detail: string | null;
  driver: { id: string; firstName: string; lastName: string } | null;
}

interface Frame {
  sessionId: string;
  image: string;
  width: number;
  height: number;
  sequence: number;
}

/**
 * Ce que chaque état veut dire pour la personne qui regarde l'écran.
 *
 * Traduit en conséquence, pas en vocabulaire technique : un administrateur doit
 * comprendre s'il faut attendre, rappeler le chauffeur, ou renoncer.
 */
const STATE_LABEL: Record<ScreenShareSession['state'], string> = {
  REQUESTED: 'En attente de la réponse du chauffeur.',
  ACCEPTED: 'Partage en cours.',
  REFUSED: 'Le chauffeur a refusé.',
  ENDED_BY_DRIVER: 'Le chauffeur a mis fin au partage.',
  ENDED_BY_ADMIN: 'Vous avez mis fin au partage.',
  EXPIRED: 'La séance s’est terminée d’elle-même.',
  FAILED: 'La capture n’a pas pu démarrer sur le téléphone.',
};

const LIVE_STATES: ScreenShareSession['state'][] = ['REQUESTED', 'ACCEPTED'];

/**
 * Partage d'écran, côté exploitation.
 *
 * Deux choses que cette interface dit explicitement, parce qu'elles ne vont pas
 * de soi :
 *
 * - **Demander n'est pas obtenir.** Tant que le chauffeur n'a pas répondu, il
 *   n'y a rien à voir, et l'écran le dit plutôt que d'afficher un cadre noir
 *   qu'on prendrait pour une lenteur du réseau.
 * - **Le chauffeur voit ce qui se passe** et peut couper à tout moment. Le
 *   rappeler ici évite qu'on s'étonne d'une séance interrompue.
 *
 * Les images ne sont ni téléchargeables ni enregistrées : elles arrivent par le
 * flux temps réel, s'affichent, et sont remplacées par la suivante.
 */
export function ScreenSharePanel({ deviceId }: { deviceId: string }) {
  const { subscribe } = useRealtime();
  const [session, setSession] = useState<ScreenShareSession | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const sessionRef = useRef<string | null>(null);

  sessionRef.current = session?.id ?? null;

  useEffect(() => {
    const off = subscribe('screen-share.frame', (payload) => {
      const incoming = payload as Frame;
      // Une image d'une autre séance n'a rien à faire ici : elle arriverait
      // après une séance close et afficherait un écran qu'on n'a plus le droit
      // de voir.
      if (incoming.sessionId !== sessionRef.current) return;
      setFrame(incoming);
    });
    return off;
  }, [subscribe]);

  useEffect(() => {
    const off = subscribe('screen-share.changed', (payload) => {
      const change = payload as Partial<ScreenShareSession> & { id: string };
      if (change.id !== sessionRef.current) return;
      setSession((current) => (current ? { ...current, ...change } : current));
      if (change.state && !LIVE_STATES.includes(change.state)) setFrame(null);
    });
    return off;
  }, [subscribe]);

  const request = useMutation({
    mutationFn: () =>
      api<ScreenShareSession>(`/v1/screen-share/devices/${deviceId}`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: (created) => {
      setError(null);
      setFrame(null);
      setSession(created);
    },
    onError: (e) => setError((e as Error).message),
  });

  const stop = useMutation({
    mutationFn: () =>
      api<ScreenShareSession>(`/v1/screen-share/${session!.id}/stop`, {
        method: 'POST',
      }),
    onSuccess: (ended) => {
      setSession(ended);
      setFrame(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  const live = session !== null && LIVE_STATES.includes(session.state);

  return (
    <Card title="Voir l’écran" className="mt-4">
      <div className="space-y-4 p-5">
        {!live && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim().length >= 10) request.mutate();
            }}
          >
            <label className="block">
              <span className="label">Motif de la demande</span>
              <input
                className="field mt-1 w-full"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Le chauffeur ne trouve pas le bouton de fin de tournée."
                required
              />
            </label>

            <p className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
              Ce texte s’affiche tel quel sur le téléphone, avec votre nom. Le
              chauffeur décide au vu de ces deux informations, et peut refuser.
            </p>

            <button
              className="btn btn-primary"
              disabled={reason.trim().length < 10 || request.isPending}
            >
              {request.isPending ? 'Envoi…' : 'Demander à voir l’écran'}
            </button>
          </form>
        )}

        {error && (
          <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
            {error}
          </p>
        )}

        {session && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">
                {STATE_LABEL[session.state]}
                {session.detail && (
                  <span
                    className="ml-2 text-xs"
                    style={{ color: 'var(--color-ink-muted)' }}
                  >
                    {session.detail}
                  </span>
                )}
              </span>

              {live && (
                <button
                  className="btn btn-secondary"
                  onClick={() => stop.mutate()}
                  disabled={stop.isPending}
                >
                  Arrêter
                </button>
              )}
            </div>

            {session.state === 'REQUESTED' && (
              <EmptyState>
                Rien ne s’affiche tant que le chauffeur n’a pas accepté. La
                demande expire d’elle-même s’il ne répond pas.
              </EmptyState>
            )}

            {session.state === 'ACCEPTED' && !frame && (
              <EmptyState>
                Accord donné. La première image arrive dans un instant — le
                téléphone doit encore passer la confirmation système d’Android.
              </EmptyState>
            )}

            {frame && (
              <div className="space-y-2">
                <div
                  className="mx-auto overflow-hidden rounded-lg"
                  style={{
                    maxWidth: 320,
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-surface-sunken)',
                  }}
                >
                  {/*
                    Balise img native volontaire : la source est une data-URI
                    reconstruite a chaque image, que l'optimiseur de Next ne peut
                    ni mettre en cache ni redimensionner utilement.
                  */}
                  <img
                    src={`data:image/jpeg;base64,${frame.image}`}
                    alt="Écran du téléphone, partagé avec l’accord du chauffeur"
                    className="block w-full"
                    // Le glisser-déposer sauvegarderait l'image : rien ici n'est
                    // destiné à être conservé, et l'interface ne doit pas
                    // suggérer le contraire.
                    draggable={false}
                  />
                </div>
                <p
                  className="text-center text-xs"
                  style={{ color: 'var(--color-ink-faint)' }}
                >
                  Image {frame.sequence} · {frame.width}×{frame.height} · rien
                  n’est enregistré
                </p>
              </div>
            )}

            {live && (
              <p className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
                Le chauffeur voit un bandeau permanent et peut couper le partage
                à tout moment. La séance se ferme seule à l’échéance.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
