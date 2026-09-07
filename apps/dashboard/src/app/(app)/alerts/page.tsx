'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AlertRow, type Paginated } from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
  severityTone,
} from '@/components/ui';
import { alertTypeLabel, formatAge, formatDateTime, fullName } from '@/lib/format';

const TAKE = 30;

export default function AlertsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const [skip, setSkip] = useState(0);

  const query = useQuery({
    queryKey: ['alerts', 'list', status, skip],
    queryFn: () =>
      api<Paginated<AlertRow>>(
        `/v1/alerts?take=${TAKE}&skip=${skip}${status ? `&status=${status}` : ''}`,
      ),
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/alerts/${id}/acknowledge`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const resolve = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/alerts/${id}/resolve`, { method: 'POST', body: {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });

  return (
    <>
      <PageHeader
        title="Alertes"
        description="Les alertes se dédupliquent : un téléphone muet depuis trois heures n’en produit qu’une."
      />

      <Card
        title={`${query.data?.total ?? '—'} alerte(s)`}
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
            <option value="OPEN">Ouvertes</option>
            <option value="ACKNOWLEDGED">Acquittées</option>
            <option value="RESOLVED">Résolues</option>
            <option value="AUTO_CLOSED">Refermées automatiquement</option>
            <option value="">Toutes</option>
          </select>
        }
      >
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={6} />}

        {query.data && query.data.items.length === 0 && (
          <EmptyState>
            {status === 'OPEN'
              ? 'Aucune alerte ouverte. La flotte est sereine.'
              : 'Aucune alerte pour ce filtre.'}
          </EmptyState>
        )}

        {query.data?.items.map((alert) => (
          <article
            key={alert.id}
            className="px-5 py-4"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
                  <span className="text-sm font-semibold">
                    {alertTypeLabel(alert.type)}
                  </span>
                  <span
                    className="mono text-xs"
                    style={{ color: 'var(--color-ink-faint)' }}
                    title={formatDateTime(alert.createdAt)}
                  >
                    {formatAge(alert.createdAt)}
                  </span>
                  {alert.status !== 'OPEN' && (
                    <Badge tone="idle">{alert.status}</Badge>
                  )}
                </div>

                <p className="mt-1.5 text-sm">{alert.message}</p>

                <div
                  className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
                  style={{ color: 'var(--color-ink-muted)' }}
                >
                  {alert.device && (
                    <Link
                      href={`/devices/${alert.device.id}`}
                      className="mono"
                      style={{ color: 'var(--color-accent)' }}
                    >
                      {alert.device.assetTag}
                    </Link>
                  )}
                  {alert.user && (
                    <Link
                      href={`/users/${alert.user.id}`}
                      style={{ color: 'var(--color-accent)' }}
                    >
                      {fullName(alert.user)}
                    </Link>
                  )}
                  {alert.depot && <span>{alert.depot.name}</span>}
                  {/* L'heure locale du dépôt figure dans le contexte : une
                      alerte relue le lendemain doit rester interprétable sans
                      conversion mentale depuis UTC. */}
                  {typeof alert.context?.localTime === 'string' && (
                    <span className="mono">{alert.context.localTime as string}</span>
                  )}
                  {alert.latitude != null && alert.longitude != null && (
                    <span className="mono">
                      {alert.latitude.toFixed(5)}, {alert.longitude.toFixed(5)}
                    </span>
                  )}
                </div>
              </div>

              {alert.status === 'OPEN' && (
                <div className="flex shrink-0 gap-2">
                  <button
                    className="btn btn-secondary"
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate(alert.id)}
                  >
                    Acquitter
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate(alert.id)}
                  >
                    Clôturer
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}

        {query.data && (
          <Pagination
            total={query.data.total}
            take={TAKE}
            skip={skip}
            onChange={setSkip}
          />
        )}
      </Card>
    </>
  );
}
