'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Paginated, type SessionRow } from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
} from '@/components/ui';
import { formatDateTime, fullName } from '@/lib/format';

const TAKE = 50;

export default function SessionsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('ACTIVE');
  const [skip, setSkip] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['sessions', 'list', status, skip],
    queryFn: () =>
      api<Paginated<SessionRow>>(
        `/v1/sessions?take=${TAKE}&skip=${skip}${status ? `&status=${status}` : ''}`,
      ),
  });

  const end = useMutation({
    mutationFn: (id: string) => api(`/v1/sessions/${id}/end`, { method: 'POST' }),
    onSuccess: () => {
      setMessage(
        'Session close et commande de déconnexion émise. Le téléphone se verrouillera à sa prochaine synchronisation.',
      );
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Une session est ouverte par un scan de badge et fermée par un nouveau scan, une commande ou le verrouillage planifié."
      />

      {message && (
        <div
          className="mb-4 rounded-lg px-4 py-3 text-sm"
          style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent)' }}
          role="status"
        >
          {message}
        </div>
      )}

      <Card
        title={`${query.data?.total ?? '—'} session(s)`}
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
            <option value="ACTIVE">Actives</option>
            <option value="ENDED">Terminées</option>
            <option value="EXPIRED">Expirées</option>
            <option value="REVOKED">Révoquées</option>
            <option value="">Toutes</option>
          </select>
        }
      >
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={6} />}

        {query.data && query.data.items.length === 0 && (
          <EmptyState>Aucune session pour ce filtre.</EmptyState>
        )}

        {query.data && query.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Chauffeur</th>
                  <th>Téléphone</th>
                  <th>Dépôt</th>
                  <th>Début</th>
                  <th>Retour</th>
                  <th>Fin</th>
                  <th>État</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <Link
                        href={`/users/${session.user.id}`}
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {fullName(session.user)}
                      </Link>
                    </td>
                    <td>
                      <Link
                        href={`/devices/${session.device.id}`}
                        className="mono"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {session.device.assetTag}
                      </Link>
                    </td>
                    <td>{session.depot?.name ?? '—'}</td>
                    <td className="text-xs">{formatDateTime(session.startedAt)}</td>
                    <td className="text-xs">
                      {session.returnedAt ? (
                        formatDateTime(session.returnedAt)
                      ) : (
                        <span style={{ color: 'var(--color-ink-faint)' }}>—</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {session.endedAt ? formatDateTime(session.endedAt) : '—'}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={session.status === 'ACTIVE' ? 'ok' : 'idle'}>
                          {session.status}
                        </Badge>
                        {session.state === 'RETURNED' && (
                          <Badge tone="accent">Retourné</Badge>
                        )}
                        {session.openedOffline && (
                          <Badge tone="warn">Hors ligne</Badge>
                        )}
                      </div>
                    </td>
                    <td className="text-right">
                      {session.status === 'ACTIVE' && (
                        <button
                          className="btn btn-secondary"
                          disabled={end.isPending}
                          onClick={() => end.mutate(session.id)}
                        >
                          Terminer
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
    </>
  );
}
