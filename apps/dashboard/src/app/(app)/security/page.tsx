'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type Paginated,
  type ScanEventRow,
  type SecurityEventRow,
} from '@/lib/api';
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
import {
  formatDateTime,
  fullName,
  scanResultLabel,
  securityTypeLabel,
} from '@/lib/format';

const TAKE = 50;

export default function SecurityPage() {
  const [tab, setTab] = useState<'events' | 'scans'>('events');
  const [skip, setSkip] = useState(0);
  const [severity, setSeverity] = useState('');

  const events = useQuery({
    queryKey: ['security', 'events', skip, severity],
    queryFn: () =>
      api<Paginated<SecurityEventRow>>(
        `/v1/security/events?take=${TAKE}&skip=${skip}${
          severity ? `&severity=${severity}` : ''
        }`,
      ),
    enabled: tab === 'events',
  });

  const scans = useQuery({
    queryKey: ['security', 'scans', skip],
    queryFn: () =>
      api<Paginated<ScanEventRow>>(`/v1/security/scans?take=${TAKE}&skip=${skip}&days=30`),
    enabled: tab === 'scans',
  });

  const active = tab === 'events' ? events : scans;

  return (
    <>
      <PageHeader
        title="Sécurité"
        description="Historique des événements et des scans de badge. Aucun numéro de badge n’apparaît ici, même pour un badge inconnu."
      />

      <div className="mb-4 flex gap-2">
        <button
          className={`btn ${tab === 'events' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => {
            setTab('events');
            setSkip(0);
          }}
        >
          Événements
        </button>
        <button
          className={`btn ${tab === 'scans' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => {
            setTab('scans');
            setSkip(0);
          }}
        >
          Scans de badge
        </button>
      </div>

      <Card
        title={`${active.data?.total ?? '—'} entrée(s)`}
        action={
          tab === 'events' ? (
            <select
              className="field w-auto"
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value);
                setSkip(0);
              }}
              aria-label="Filtrer par gravité"
            >
              <option value="">Toutes gravités</option>
              <option value="CRITICAL">Critique</option>
              <option value="HIGH">Élevée</option>
              <option value="MEDIUM">Moyenne</option>
              <option value="LOW">Faible</option>
            </select>
          ) : null
        }
      >
        {active.isError && <ErrorState message={(active.error as Error).message} />}
        {active.isLoading && <Skeleton rows={8} />}

        {tab === 'events' && events.data && (
          events.data.items.length === 0 ? (
            <EmptyState>Aucun événement.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Événement</th>
                    <th>Gravité</th>
                    <th>Téléphone</th>
                    <th>Chauffeur</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.items.map((event) => (
                    <tr key={event.id}>
                      <td>{securityTypeLabel(event.type)}</td>
                      <td>
                        <Badge tone={severityTone(event.severity)}>{event.severity}</Badge>
                      </td>
                      <td>
                        {event.device ? (
                          <Link
                            href={`/devices/${event.device.id}`}
                            className="mono"
                            style={{ color: 'var(--color-accent)' }}
                          >
                            {event.device.assetTag}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{event.user ? fullName(event.user) : '—'}</td>
                      <td className="text-xs">{formatDateTime(event.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'scans' && scans.data && (
          scans.data.items.length === 0 ? (
            <EmptyState>Aucun scan sur les trente derniers jours.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Résultat</th>
                    <th>Badge</th>
                    <th>Téléphone</th>
                    <th>Chauffeur</th>
                    <th>Mode</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {scans.data.items.map((scan) => (
                    <tr key={scan.id}>
                      <td>
                        <Badge tone={scan.result === 'SUCCESS' ? 'ok' : 'danger'}>
                          {scanResultLabel(scan.result)}
                        </Badge>
                      </td>
                      <td className="mono">
                        {scan.barcodeLast4 ? `****${scan.barcodeLast4}` : '—'}
                      </td>
                      <td>
                        {scan.device ? (
                          <Link
                            href={`/devices/${scan.device.id}`}
                            className="mono"
                            style={{ color: 'var(--color-accent)' }}
                          >
                            {scan.device.assetTag}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{scan.user ? fullName(scan.user) : '—'}</td>
                      <td>
                        {scan.offline ? <Badge tone="warn">Hors ligne</Badge> : 'En ligne'}
                      </td>
                      <td className="text-xs">{formatDateTime(scan.scannedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {active.data && (
          <Pagination
            total={active.data.total}
            take={TAKE}
            skip={skip}
            onChange={setSkip}
          />
        )}
      </Card>
    </>
  );
}
