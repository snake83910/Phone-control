'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AuditLogRow, type Paginated } from '@/lib/api';
import {
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';

const TAKE = 50;

const ACTION_LABELS: Record<string, string> = {
  ADMIN_CREATE_DEVICE: 'Création de téléphone',
  ADMIN_CREATE_ENROLLMENT_TOKEN: 'Jeton d’enrôlement généré',
  ADMIN_LOCK_DEVICE: 'Verrouillage demandé',
  ADMIN_UNLOCK_DEVICE: 'Déverrouillage demandé',
  ADMIN_FORCE_LOGOUT: 'Déconnexion forcée',
  ADMIN_WIPE_DEVICE: 'Effacement demandé',
  ADMIN_LOCATE_DEVICE: 'Localisation demandée',
  ADMIN_REVOKE_DEVICE: 'Téléphone révoqué',
  ADMIN_CREATE_USER: 'Création de chauffeur',
  ADMIN_DISABLE_USER: 'Statut de chauffeur modifié',
  ADMIN_ANONYMIZE_USER: 'Anonymisation RGPD',
  ADMIN_ASSIGN_DEVICE: 'Téléphone autorisé',
  ADMIN_UNASSIGN_DEVICE: 'Autorisation retirée',
  ADMIN_CREATE_BADGE: 'Badge enregistré',
  ADMIN_REVOKE_BADGE: 'Badge révoqué',
  ADMIN_REASSIGN_BADGE: 'Badge réaffecté',
  ADMIN_UPDATE_BADGE_STATUS: 'Statut de badge modifié',
  ADMIN_CREATE_DEPOT: 'Création de dépôt',
  ADMIN_CHANGE_DEPOT: 'Dépôt modifié',
  ADMIN_END_SESSION: 'Session terminée',
  ADMIN_ACKNOWLEDGE_ALERT: 'Alerte acquittée',
  ADMIN_RESOLVE_ALERT: 'Alerte clôturée',
  ADMIN_CREATE_COMPANY: 'Création d’entreprise',
  ADMIN_UPDATE_COMPANY: 'Entreprise modifiée',
  ADMIN_UPDATE_RETENTION: 'Rétention modifiée',
};

export default function AuditLogsPage() {
  const [skip, setSkip] = useState(0);
  const [resourceType, setResourceType] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['audit', skip, resourceType],
    queryFn: () =>
      api<Paginated<AuditLogRow>>(
        `/v1/audit-logs?take=${TAKE}&skip=${skip}${
          resourceType ? `&resourceType=${resourceType}` : ''
        }`,
      ),
  });

  return (
    <>
      <PageHeader
        title="Journal d’audit"
        description="Table en insertion seule, protégée au niveau de PostgreSQL : ni l’application ni cette interface ne peuvent la modifier."
      />

      <Card
        title={`${query.data?.total ?? '—'} entrée(s)`}
        action={
          <select
            className="field w-auto"
            value={resourceType}
            onChange={(e) => {
              setResourceType(e.target.value);
              setSkip(0);
            }}
            aria-label="Filtrer par ressource"
          >
            <option value="">Toutes ressources</option>
            <option value="device">Téléphones</option>
            <option value="user">Chauffeurs</option>
            <option value="badge">Badges</option>
            <option value="depot">Dépôts</option>
            <option value="session">Sessions</option>
            <option value="alert">Alertes</option>
            <option value="company">Entreprises</option>
          </select>
        }
      >
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={8} />}

        {query.data && query.data.items.length === 0 && (
          <EmptyState>Aucune action enregistrée.</EmptyState>
        )}

        {query.data && query.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Ressource</th>
                  <th>Administrateur</th>
                  <th>Adresse IP</th>
                  <th>Date</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((log) => (
                  <>
                    <tr key={log.id}>
                      <td>{ACTION_LABELS[log.action] ?? log.action}</td>
                      <td className="mono text-xs">
                        {log.resourceType}
                        {log.resourceId ? ` · ${log.resourceId.slice(0, 8)}…` : ''}
                      </td>
                      <td>
                        {log.admin ? (
                          <>
                            {log.admin.firstName} {log.admin.lastName}
                            <div
                              className="text-xs"
                              style={{ color: 'var(--color-ink-faint)' }}
                            >
                              {log.admin.email}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: 'var(--color-ink-faint)' }}>système</span>
                        )}
                      </td>
                      <td className="mono text-xs">{log.ip ?? '—'}</td>
                      <td className="text-xs">{formatDateTime(log.createdAt)}</td>
                      <td className="text-right">
                        <button
                          className="btn btn-secondary"
                          onClick={() =>
                            setExpanded(expanded === log.id ? null : log.id)
                          }
                          aria-expanded={expanded === log.id}
                        >
                          {expanded === log.id ? 'Masquer' : 'Détail'}
                        </button>
                      </td>
                    </tr>
                    {expanded === log.id && (
                      <tr key={`${log.id}-detail`}>
                        <td colSpan={6} style={{ background: 'var(--color-surface-raised)' }}>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Diff title="Avant" value={log.before} />
                            <Diff title="Après" value={log.after} />
                          </div>
                          {log.correlationId && (
                            <p
                              className="mono mt-2 text-xs"
                              style={{ color: 'var(--color-ink-faint)' }}
                            >
                              Identifiant de corrélation : {log.correlationId}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
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

function Diff({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="label mb-1">{title}</div>
      <pre
        className="mono overflow-x-auto rounded-md p-2 text-xs"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
        }}
      >
        {value ? JSON.stringify(value, null, 2) : '—'}
      </pre>
    </div>
  );
}
