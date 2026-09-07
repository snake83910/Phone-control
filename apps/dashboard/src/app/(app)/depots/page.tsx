'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DepotRow } from '@/lib/api';
import {
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
} from '@/components/ui';

/**
 * Lit un couple de coordonnees colle depuis une carte.
 *
 * Personne ne connait la latitude de son depot par coeur : on la copie depuis
 * Google Maps, qui la donne sous la forme « 43.296482, 5.36978 ». Accepter
 * cette forme telle quelle evite la manipulation ou l'on colle les deux
 * nombres dans le meme champ sans s'en apercevoir.
 *
 * Le point-virgule et l'espace seule sont acceptes : les tableurs francais
 * produisent l'un ou l'autre selon les reglages regionaux.
 */
function parseCoordinates(
  raw: string,
): { latitude: number; longitude: number } | null {
  const parts = raw.trim().split(/[;,\s]+/).filter((p) => p.length > 0);
  if (parts.length !== 2) return null;

  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return { latitude, longitude };
}

export default function DepotsPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState({ code: '', name: '', coordinates: '' });

  const query = useQuery({
    queryKey: ['depots', 'list'],
    queryFn: () => api<DepotRow[]>('/v1/depots'),
  });

  const coordinates = parseCoordinates(draft.coordinates);

  /**
   * Creation d'un depot.
   *
   * Volontairement reduite a l'indispensable : un code, un nom, un point sur
   * la carte. Le rayon, les heures de retour et de verrouillage ne sont PAS
   * saisis ici et ne sont pas non plus preremplies — ce sont des valeurs
   * metier, elles vivent en configuration cote serveur (specification §61).
   * Les ecrire en dur dans ce formulaire les dupliquerait, et deux copies
   * finissent toujours par diverger.
   *
   * Elles se reglent ensuite sur la fiche du depot, ou elles sont affichees
   * avec leur effet du jour.
   */
  const create = useMutation({
    mutationFn: () =>
      api<DepotRow>('/v1/depots', {
        method: 'POST',
        body: {
          code: draft.code.trim().toUpperCase(),
          name: draft.name.trim(),
          latitude: coordinates!.latitude,
          longitude: coordinates!.longitude,
        },
      }),
    onSuccess: (depot) => {
      setDraft({ code: '', name: '', coordinates: '' });
      setMessage(
        `${depot.name} est créé, avec un rayon de ${depot.radiusMeters} m et un ` +
          `retour à ${depot.returnTime}. Ajustez-le sur sa fiche si besoin.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['depots'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const canSubmit =
    draft.code.trim().length > 0 &&
    draft.name.trim().length > 0 &&
    coordinates !== null;

  return (
    <>
      <PageHeader
        title="Dépôts"
        description="Les heures de retour et de verrouillage s’interprètent dans le fuseau du dépôt, jamais dans celui du navigateur."
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

      <Card title="Ajouter un dépôt" className="mb-4">
        <form
          className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <label className="block">
            <span className="label">Code</span>
            <input
              className="field mono mt-1 w-full"
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              placeholder="MRS"
              required
            />
          </label>

          <label className="block">
            <span className="label">Nom</span>
            <input
              className="field mt-1 w-full"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Dépôt Marseille"
              required
            />
          </label>

          <label className="block">
            <span className="label">Coordonnées</span>
            <input
              className="field mono mt-1 w-full"
              value={draft.coordinates}
              onChange={(e) =>
                setDraft({ ...draft, coordinates: e.target.value })
              }
              placeholder="43.296482, 5.36978"
              required
            />
          </label>

          <div className="flex items-end">
            <button
              className="btn btn-primary w-full"
              disabled={!canSubmit || create.isPending}
            >
              {create.isPending ? 'Création…' : 'Créer'}
            </button>
          </div>
        </form>

        <p
          className="px-5 pb-4 text-xs"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          {draft.coordinates.trim().length > 0 && coordinates === null
            ? 'Deux nombres attendus, latitude puis longitude — copiez-les depuis une carte, par exemple « 43.296482, 5.36978 ».'
            : 'Rayon, heures de retour et de verrouillage prennent les valeurs par défaut du système, et se règlent ensuite sur la fiche du dépôt.'}
        </p>
      </Card>

      <Card title={`${query.data?.length ?? '—'} dépôt(s)`}>
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={4} />}

        {query.data && query.data.length === 0 && (
          <EmptyState>Aucun dépôt configuré.</EmptyState>
        )}

        {query.data && query.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Dépôt</th>
                  <th>Fuseau</th>
                  <th>Retour</th>
                  <th>Verrouillage</th>
                  <th>Rayon</th>
                  <th>Téléphones</th>
                  <th>Chauffeurs</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((depot) => (
                  <tr key={depot.id}>
                    <td>
                      <Link
                        href={`/depots/${depot.id}`}
                        className="font-medium"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {depot.name}
                      </Link>
                      <div className="mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
                        {depot.code}
                      </div>
                    </td>
                    <td className="text-xs">{depot.timezone}</td>
                    <td className="mono">{depot.returnTime}</td>
                    <td className="mono">{depot.lockTime}</td>
                    <td className="mono">
                      {depot.radiusMeters} m
                      <span
                        className="ml-1 text-xs"
                        style={{ color: 'var(--color-ink-faint)' }}
                        title="Marge supplémentaire exigée pour considérer une sortie"
                      >
                        (+{depot.exitHysteresisMeters})
                      </span>
                    </td>
                    <td className="mono">{depot._count?.devices ?? '—'}</td>
                    <td className="mono">{depot._count?.users ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
        La marge de sortie rend la sortie plus exigeante que l’entrée : un
        téléphone posé sur la limite du dépôt n’oscille pas entre les deux états,
        et ne déclenche donc pas d’alerte à répétition.
      </p>
    </>
  );
}
