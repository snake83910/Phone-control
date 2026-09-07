'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, ErrorState, PageHeader, Skeleton } from '@/components/ui';
import { AppDeploymentCard } from '@/components/app-deployment';

interface AppPolicy {
  allowedApps: string[];
  blockedApps: string[];
  version: number;
  protectedPackages: string[];
}

/**
 * Un paquet par ligne.
 *
 * Format délibérément pauvre : c'est celui qui correspond à la manière dont un
 * administrateur obtient réellement ces valeurs — copiées une à une depuis
 * l'adresse d'une fiche Play Store. Un composant à jetons ferait joli et
 * rendrait le collage de dix lignes pénible.
 */
const toLines = (values: string[]): string => values.join('\n');
const fromLines = (raw: string): string[] =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export default function AppPolicyPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const policy = useQuery({
    queryKey: ['settings', 'apps'],
    queryFn: () => api<AppPolicy>('/v1/settings/apps'),
  });

  useEffect(() => {
    if (policy.data && allowed === null && blocked === null) {
      setAllowed(toLines(policy.data.allowedApps));
      setBlocked(toLines(policy.data.blockedApps));
    }
  }, [policy.data, allowed, blocked]);

  const save = useMutation({
    mutationFn: () =>
      api<AppPolicy>('/v1/settings/apps', {
        method: 'PUT',
        body: {
          allowedApps: fromLines(allowed ?? ''),
          blockedApps: fromLines(blocked ?? ''),
        },
      }),
    onSuccess: (data) => {
      setError(null);
      setAllowed(toLines(data.allowedApps));
      setBlocked(toLines(data.blockedApps));
      setMessage(
        'Politique enregistrée. Les téléphones l’appliqueront à leur prochaine ' +
          'synchronisation, et chacun rapportera ce qu’il a réellement pu faire.',
      );
      void queryClient.invalidateQueries({ queryKey: ['settings', 'apps'] });
    },
    onError: (e) => {
      setMessage(null);
      setError((e as Error).message);
    },
  });

  if (policy.isError) {
    return <ErrorState message={(policy.error as Error).message} />;
  }
  const loaded = policy.data;
  if (!loaded || allowed === null || blocked === null) {
    return <Skeleton rows={6} />;
  }

  return (
    <>
      <PageHeader
        title="Applications"
        description="Ce que les téléphones de la flotte installent, laissent ouvrir, et masquent."
      />

      {message && (
        <div
          className="mb-4 rounded-lg px-4 py-3 text-sm"
          style={{
            background: 'var(--color-accent-soft)',
            color: 'var(--color-accent)',
          }}
          role="status"
        >
          {message}
        </div>
      )}

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}

      {/*
        Ce paragraphe n'est pas décoratif. Sans lui, un administrateur qui
        enregistre une politique croit avoir bloqué quelque chose — alors qu'il
        a seulement exprimé une intention, dont l'effet dépend d'un privilège
        Android accordé au provisioning (§67).
      */}
      <Card title="Ce que cette page fait, et ne fait pas">
        <div
          className="space-y-2 px-5 py-4 text-sm"
          style={{ color: 'var(--color-ink-muted)' }}
        >
          <p>
            Cette page enregistre une <strong>consigne</strong>. Le blocage lui-même
            a lieu sur chaque téléphone, et n’est possible que si l’application y
            est administrateur de l’appareil — privilège accordé à la mise en
            service, jamais après coup.
          </p>
          <p>
            Ce qu’un téléphone a <strong>réellement</strong> masqué se lit sur sa
            fiche, dans « Politique d’applications ». C’est le seul endroit qui
            dise la vérité sur l’état d’un appareil.
          </p>
        </div>
      </Card>

      <form
        className="mt-4 grid gap-4 lg:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Card title="Applications bloquées">
          <div className="space-y-3 p-5">
            <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
              Elles disparaissent du menu et ne se lancent plus, session ouverte
              ou non. Elles ne sont pas désinstallées : retirer une ligne d’ici
              la fait réapparaître telle qu’elle était.
            </p>
            <label className="block">
              <span className="label">Un nom de paquet par ligne</span>
              <textarea
                className="field mono mt-1 h-48 w-full"
                spellCheck={false}
                value={blocked}
                onChange={(e) => setBlocked(e.target.value)}
                placeholder={'com.supercell.clashofclans\ncom.zhiliaoapp.musically'}
              />
            </label>
            <p className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
              Le nom de paquet se lit dans l’adresse de la fiche Play Store :
              <span className="mono"> …/store/apps/details?id=</span>
              <strong className="mono">com.exemple.application</strong>.
            </p>
          </div>
        </Card>

        <Card title="Applications autorisées">
          <div className="space-y-3 p-5">
            <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
              Elles peuvent s’ouvrir <em>à côté</em> de l’application pendant une
              session — navigation, appareil photo métier. En mode kiosque, tout
              ce qui n’est pas listé ici reste inaccessible.
            </p>
            <label className="block">
              <span className="label">Un nom de paquet par ligne</span>
              <textarea
                className="field mono mt-1 h-48 w-full"
                spellCheck={false}
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
                placeholder={'com.google.android.apps.maps'}
              />
            </label>
            <p className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
              Une application présente dans les deux listes est bloquée : entre
              ouvrir et fermer, un système de verrouillage ferme.
            </p>
          </div>
        </Card>

        <div className="lg:col-span-2">
          <button className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <span
            className="ml-3 text-xs"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            Version de configuration {loaded.version} — les téléphones
            comparent ce numéro pour savoir s’ils doivent se remettre à jour.
          </span>
        </div>
      </form>

      <AppDeploymentCard />

      <Card title="Applications qui ne peuvent pas être bloquées" className="mt-4">
        <div className="p-5">
          <p className="mb-3 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Masquer l’un de ces paquets rendrait le téléphone inutilisable, ou
            couperait le canal qui permet de le corriger à distance — auquel cas
            la réparation se fait appareil par appareil, en atelier. La demande
            est refusée ici, et refusée une seconde fois par le téléphone.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {loaded.protectedPackages.map((pkg) => (
              <li
                key={pkg}
                className="mono rounded px-2 py-1 text-xs"
                style={{
                  background: 'var(--color-surface-sunken)',
                  color: 'var(--color-ink-muted)',
                }}
              >
                {pkg}
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </>
  );
}
