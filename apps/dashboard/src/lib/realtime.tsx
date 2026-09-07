'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Flux temps réel.
 *
 * Le dashboard reçoit les alertes et les changements d'état sans interroger le
 * serveur en boucle. Une sortie après retour doit apparaître en quelques
 * secondes : un rafraîchissement toutes les trente secondes serait à la fois
 * plus lent et plus coûteux.
 *
 * Le jeton de poignée de main est récupéré à la demande auprès du serveur Next
 * et gardé en mémoire uniquement — jamais dans localStorage.
 */

export interface RealtimeAlert {
  id: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  message: string;
  deviceId: string | null;
  createdAt: string;
}

interface RealtimeState {
  connected: boolean;
  lastAlert: RealtimeAlert | null;
  /** Alertes reçues depuis l'ouverture de la page, les plus récentes d'abord. */
  liveAlerts: RealtimeAlert[];
  dismiss: (id: string) => void;
  /**
   * Abonnement ponctuel à un événement du flux.
   *
   * Existe pour les usages qui ne concernent qu'une page — les images d'un
   * partage d'écran, par exemple, qui n'ont aucune raison de transiter par un
   * état global. Renvoie la fonction de désabonnement.
   *
   * L'abonnement survit aux reconnexions : le socket est recréé sans que la
   * page en soit avertie, et perdre le flux à la première coupure réseau
   * donnerait un écran figé sans explication.
   */
  subscribe: (event: string, handler: (payload: unknown) => void) => () => void;
}

const RealtimeContext = createContext<RealtimeState>({
  connected: false,
  lastAlert: null,
  liveAlerts: [],
  dismiss: () => undefined,
  subscribe: () => () => undefined,
});

export function useRealtime(): RealtimeState {
  return useContext(RealtimeContext);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [liveAlerts, setLiveAlerts] = useState<RealtimeAlert[]>([]);
  const socketRef = useRef<Socket | null>(null);
  // Abonnements des pages, conserves hors du socket : c'est ce qui permet de
  // les recabler apres une reconnexion.
  const listenersRef = useRef(new Map<string, Set<(payload: unknown) => void>>());

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const response = await fetch('/api/auth/ws-token');
      if (!response.ok) return;
      const { token } = (await response.json()) as { token: string };
      if (cancelled) return;

      const url =
        process.env.NEXT_PUBLIC_REALTIME_URL ?? window.location.origin;

      const socket = io(`${url}/realtime`, {
        auth: { token },
        transports: ['websocket'],
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30_000,
      });
      socketRef.current = socket;

      socket.on('connect', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));

      socket.on('alert.created', (alert: RealtimeAlert) => {
        setLiveAlerts((current) => [alert, ...current].slice(0, 20));
        // Les vues concernées se rafraîchissent d'elles-mêmes : le compteur de
        // la page d'accueil et la liste des alertes doivent rester cohérents
        // avec la bannière qui vient d'apparaître.
        void queryClient.invalidateQueries({ queryKey: ['alerts'] });
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      });

      socket.on('alert.updated', () => {
        void queryClient.invalidateQueries({ queryKey: ['alerts'] });
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      });

      socket.on('device.updated', () => {
        void queryClient.invalidateQueries({ queryKey: ['devices'] });
        void queryClient.invalidateQueries({ queryKey: ['live-positions'] });
      });

      // Recablage des abonnements des pages, a chaque (re)connexion.
      for (const [event, handlers] of listenersRef.current) {
        socket.on(event, (payload: unknown) => {
          for (const handler of handlers) handler(payload);
        });
      }

      socket.on('session.changed', () => {
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['devices'] });
        void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      });
    }

    void connect();

    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [queryClient]);

  const value = useMemo<RealtimeState>(
    () => ({
      connected,
      lastAlert: liveAlerts[0] ?? null,
      liveAlerts,
      dismiss: (id: string) =>
        setLiveAlerts((current) => current.filter((a) => a.id !== id)),
      subscribe: (event, handler) => {
        const handlers = listenersRef.current.get(event) ?? new Set();
        const first = handlers.size === 0;
        handlers.add(handler);
        listenersRef.current.set(event, handlers);

        // Le socket peut déjà être ouvert : on câble tout de suite, et
        // seulement pour le premier abonné de cet événement — sans quoi chaque
        // abonnement ajouterait un écouteur qui rejouerait tous les autres.
        if (first) {
          socketRef.current?.on(event, (payload: unknown) => {
            for (const h of listenersRef.current.get(event) ?? []) h(payload);
          });
        }

        return () => {
          listenersRef.current.get(event)?.delete(handler);
        };
      },
    }),
    [connected, liveAlerts],
  );

  return (
    <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
  );
}
