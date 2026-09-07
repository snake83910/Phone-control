'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type BadgeRow, type Paginated, type UserSummary } from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
} from '@/components/ui';
import { formatDate, fullName } from '@/lib/format';

const TAKE = 50;

export default function BadgesPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [barcode, setBarcode] = useState('');

  const query = useQuery({
    queryKey: ['badges', 'list', status, skip],
    queryFn: () =>
      api<Paginated<BadgeRow>>(
        `/v1/badges?take=${TAKE}&skip=${skip}${status ? `&status=${status}` : ''}`,
      ),
  });

  const drivers = useQuery({
    queryKey: ['users', 'for-badge-attachment'],
    queryFn: () => api<Paginated<UserSummary>>('/v1/users?take=200&status=ACTIVE'),
  });

  /**
   * Rattachement d'un badge existant à un chauffeur.
   *
   * C'est l'écran de la pile de badges : on en prend un, on choisit à qui il
   * est, on passe au suivant. La fiche du chauffeur porte le même formulaire
   * pour le cas inverse — un chauffeur arrive, on enregistre son badge.
   */
  const attach = useMutation({
    mutationFn: (input: { userId: string; barcode: string }) =>
      api('/v1/badges', { method: 'POST', body: input }),
    onSuccess: () => {
      // Le numéro est effacé, pas le chauffeur : on enchaîne rarement deux
      // badges pour la même personne, mais on enchaîne souvent deux numéros.
      setBarcode('');
      setMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['badges'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const changeStatus = useMutation({
    mutationFn: (input: { id: string; status: string }) =>
      api(`/v1/badges/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['badges'] });
      setMessage(null);
    },
    onError: (e) => setMessage((e as Error).message),
  });

  return (
    <>
      <PageHeader
        title="Badges"
        description="Code 128. La base ne conserve jamais le numéro en clair : seuls les quatre derniers chiffres sont affichables."
      />

      {message && <ErrorState message={message} />}

      <Card title="Rattacher un badge existant">
        <form
          className="flex flex-wrap items-end gap-3 px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (userId && barcode.trim().length >= 4) {
              attach.mutate({ userId, barcode: barcode.trim() });
            }
          }}
        >
          <label className="flex-1" style={{ minWidth: '16rem' }}>
            <span className="mb-1 block text-xs" style={{ color: 'var(--color-ink-muted)' }}>
              Chauffeur
            </span>
            <select
              className="field"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">Choisir…</option>
              {(drivers.data?.items ?? []).map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {fullName(driver)}
                  {driver.employeeNumber ? ` — ${driver.employeeNumber}` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="flex-1" style={{ minWidth: '14rem' }}>
            <span className="mb-1 block text-xs" style={{ color: 'var(--color-ink-muted)' }}>
              Numéro imprimé sur le badge
            </span>
            <input
              className="field mono"
              inputMode="numeric"
              autoComplete="off"
              placeholder="14557719"
              value={barcode}
              onChange={(event) => setBarcode(event.target.value)}
            />
          </label>

          <button
            className="btn btn-primary"
            type="submit"
            disabled={attach.isPending || !userId || barcode.trim().length < 4}
          >
            {attach.isPending ? 'Rattachement…' : 'Rattacher'}
          </button>
        </form>

        <p className="px-5 pb-4 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
          Les badges existent déjà : on n’en fabrique aucun. On enregistre
          seulement à qui appartient chaque numéro. Une douchette USB fonctionne
          comme une saisie clavier — placez le curseur dans le champ et scannez.
        </p>
      </Card>

      <div className="mt-4" />

      <Card
        title={`${query.data?.total ?? '—'} badge(s)`}
        action={
          <select
            className="field w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setSkip(0);
            }}
            aria-label="Filtrer par statut"
          >
            <option value="">Tous</option>
            <option value="ACTIVE">Actifs</option>
            <option value="INACTIVE">Inactifs</option>
            <option value="REVOKED">Révoqués</option>
            <option value="LOST">Perdus</option>
          </select>
        }
      >
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={6} />}

        {query.data && query.data.items.length === 0 && (
          <EmptyState>Aucun badge pour ce filtre.</EmptyState>
        )}

        {query.data && query.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Numéro</th>
                  <th>Type</th>
                  <th>Chauffeur</th>
                  <th>Statut</th>
                  <th>Hors ligne</th>
                  <th>Émis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((badge) => (
                  <tr key={badge.id}>
                    <td className="mono font-medium">{badge.maskedBarcode}</td>
                    <td className="text-xs">{badge.barcodeType.replace('_', ' ')}</td>
                    <td>
                      {badge.user ? (
                        <Link
                          href={`/users/${badge.user.id}`}
                          style={{ color: 'var(--color-accent)' }}
                        >
                          {fullName(badge.user)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <Badge tone={badge.status === 'ACTIVE' ? 'ok' : 'idle'}>
                        {badge.status}
                      </Badge>
                    </td>
                    <td>
                      {/* Sans valeur chiffrée, ce badge ne peut pas être vérifié
                          par un téléphone privé de réseau. */}
                      {badge.offlineCapable ? (
                        <Badge tone="ok">Possible</Badge>
                      ) : (
                        <Badge tone="warn">Indisponible</Badge>
                      )}
                    </td>
                    <td className="text-xs">{formatDate(badge.issuedAt)}</td>
                    <td className="text-right">
                      {badge.status === 'ACTIVE' && (
                        <button
                          className="btn btn-danger"
                          disabled={changeStatus.isPending}
                          onClick={() =>
                            changeStatus.mutate({ id: badge.id, status: 'REVOKED' })
                          }
                        >
                          Révoquer
                        </button>
                      )}
                      {badge.status === 'INACTIVE' && (
                        <button
                          className="btn btn-secondary"
                          disabled={changeStatus.isPending}
                          onClick={() =>
                            changeStatus.mutate({ id: badge.id, status: 'ACTIVE' })
                          }
                        >
                          Réactiver
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {query.data && (
          <Pagination total={query.data.total} take={TAKE} skip={skip} onChange={setSkip} />
        )}
      </Card>

      <p className="mt-4 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
        Un badge révoqué ne peut pas être réactivé : il faut en enregistrer un
        nouveau. C’est ce qui garantit qu’un badge perdu puis retrouvé ne
        redevient jamais valide par simple clic.
      </p>
    </>
  );
}
