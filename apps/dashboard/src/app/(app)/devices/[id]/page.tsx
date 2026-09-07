'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type AppPolicyReport,
  type DeviceDetail,
  type Paginated,
  type SecurityEventRow,
  type SessionRow,
} from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  deviceStateTone,
  severityTone,
} from '@/components/ui';
import { ScreenSharePanel } from '@/components/screen-share';
import {
  deviceStateLabel,
  formatAge,
  formatCoordinates,
  formatDateTime,
  fullName,
  securityTypeLabel,
} from '@/lib/format';

export default function DevicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<string | null>(null);

  const device = useQuery({
    queryKey: ['devices', id],
    queryFn: () => api<DeviceDetail>(`/v1/devices/${id}`),
  });

  const sessions = useQuery({
    queryKey: ['sessions', 'device', id],
    queryFn: () => api<Paginated<SessionRow>>(`/v1/sessions?deviceId=${id}&take=8`),
  });

  const events = useQuery({
    queryKey: ['security', 'device', id],
    queryFn: () =>
      api<Paginated<SecurityEventRow>>(`/v1/security/events?deviceId=${id}&take=12`),
  });

  const command = useMutation({
    mutationFn: (payload: { command: string; label: string }) =>
      api(`/v1/devices/${id}/commands`, {
        method: 'POST',
        body: { command: payload.command },
      }),
    onSuccess: (_data, payload) => {
      // Le message est volontairement au futur : la commande est en file, le
      // téléphone ne l'a pas encore exécutée. Annoncer « verrouillé » serait faux.
      setFeedback(
        `${payload.label} : commande enregistrée. Elle sera appliquée à la prochaine synchronisation du téléphone.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['devices', id] });
    },
    onError: (error) => setFeedback((error as Error).message),
  });

  if (device.isError) {
    return <ErrorState message={(device.error as Error).message} />;
  }
  if (!device.data) return <Skeleton rows={8} />;

  const d = device.data;

  return (
    <>
      <PageHeader
        title={d.assetTag}
        description={[d.manufacturer, d.model, d.androidVersion && `Android ${d.androidVersion}`]
          .filter(Boolean)
          .join(' · ')}
        action={
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-secondary" href="/devices/provisioning">
              QR de provisioning
            </Link>
            <button
              className="btn btn-secondary"
              disabled={command.isPending}
              onClick={() =>
                command.mutate({ command: 'LOCK_DEVICE', label: 'Verrouillage' })
              }
            >
              Verrouiller
            </button>
            <button
              className="btn btn-secondary"
              disabled={command.isPending || !d.currentSession}
              onClick={() =>
                command.mutate({ command: 'FORCE_LOGOUT', label: 'Déconnexion' })
              }
            >
              Déconnecter
            </button>
            <button
              className="btn btn-secondary"
              disabled={command.isPending}
              onClick={() =>
                command.mutate({
                  command: 'REFRESH_CONFIGURATION',
                  label: 'Synchronisation',
                })
              }
            >
              Synchroniser
            </button>
          </div>
        }
      />

      {feedback && (
        <div
          className="mb-4 rounded-lg px-4 py-3 text-sm"
          style={{
            background: 'var(--color-accent-soft)',
            color: 'var(--color-accent)',
          }}
          role="status"
        >
          {feedback}
        </div>
      )}

      {!d.deviceOwnerActive && d.enrollmentStatus === 'ENROLLED' && (
        <div
          className="mb-4 rounded-lg px-4 py-3 text-sm"
          style={{
            background: 'var(--color-warn-soft)',
            color: 'var(--color-warn)',
            border: '1px solid var(--color-warn)',
          }}
          role="alert"
        >
          <strong>Device Owner non confirmé.</strong> Ce téléphone n’a pas
          confirmé disposer des privilèges d’administration de l’appareil : le
          mode kiosque et les restrictions système ne sont pas garantis sur ce
          terminal.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="État" className="lg:col-span-1">
          <dl className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            <Row label="État">
              <Badge tone={deviceStateTone(d.state)}>{deviceStateLabel(d.state)}</Badge>
            </Row>
            <Row label="Enrôlement">{d.enrollmentStatus}</Row>
            <Row label="Mode">{d.kioskMode}</Row>
            <Row label="Dépôt">{d.depot?.name ?? '—'}</Row>
            <Row label="Chauffeur">
              {d.currentSession ? (
                <Link
                  href={`/users/${d.currentSession.user.id}`}
                  style={{ color: 'var(--color-accent)' }}
                >
                  {fullName(d.currentSession.user)}
                </Link>
              ) : (
                '—'
              )}
            </Row>
            <Row label="Session depuis">
              {d.currentSession ? formatDateTime(d.currentSession.startedAt) : '—'}
            </Row>
          </dl>
        </Card>

        <Card title="Matériel et réseau">
          <dl className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            <Row label="Batterie">
              {d.battery == null ? '—' : `${d.battery}%${d.charging ? ' (en charge)' : ''}`}
            </Row>
            <Row label="GPS">
              {d.gpsEnabled == null ? (
                '—'
              ) : d.gpsEnabled ? (
                <Badge tone="ok">Actif</Badge>
              ) : (
                <Badge tone="danger">Désactivé</Badge>
              )}
            </Row>
            <Row label="Réseau">{d.networkType ?? '—'}</Row>
            <Row label="Stockage libre">
              {d.storageFreeMb == null ? '—' : `${d.storageFreeMb} Mo`}
            </Row>
            <Row label="Version applicative">{d.appVersion ?? '—'}</Row>
            <Row label="Dernier signal">{formatAge(d.lastSeenAt)}</Row>
            <Row label="Dernière synchro">{formatAge(d.lastSyncAt)}</Row>
          </dl>
        </Card>

        <Card
          title="Dernière position"
          action={
            <Link href="/locations" className="text-xs" style={{ color: 'var(--color-accent)' }}>
              Voir la carte
            </Link>
          }
        >
          {d.lastLocation ? (
            <dl className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
              <Row label="Coordonnées">
                <span className="mono">
                  {formatCoordinates(d.lastLocation.latitude, d.lastLocation.longitude)}
                </span>
              </Row>
              <Row label="Précision">
                {d.lastLocation.accuracy == null
                  ? '—'
                  : `± ${Math.round(d.lastLocation.accuracy)} m`}
              </Row>
              <Row label="Relevée">{formatDateTime(d.lastLocation.at)}</Row>
              <Row label="Ancienneté">{formatAge(d.lastLocation.at)}</Row>
            </dl>
          ) : (
            <EmptyState>
              Aucune position connue. Le suivi ne démarre qu’avec une session
              active.
            </EmptyState>
          )}
        </Card>
      </div>

      <AppPolicyCard report={d.appPolicy} requested={d.settings} />

      <ScreenSharePanel deviceId={id} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Sessions récentes">
          {sessions.isLoading ? (
            <Skeleton rows={4} />
          ) : (sessions.data?.items.length ?? 0) === 0 ? (
            <EmptyState>Aucune session enregistrée.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Chauffeur</th>
                  <th>Début</th>
                  <th>Fin</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data!.items.map((session) => (
                  <tr key={session.id}>
                    <td>{fullName(session.user)}</td>
                    <td className="text-xs">{formatDateTime(session.startedAt)}</td>
                    <td className="text-xs">
                      {session.endedAt ? formatDateTime(session.endedAt) : '—'}
                    </td>
                    <td>
                      <Badge tone={session.status === 'ACTIVE' ? 'ok' : 'idle'}>
                        {session.status === 'ACTIVE' && session.state === 'RETURNED'
                          ? 'Retourné'
                          : session.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Historique de sécurité">
          {events.isLoading ? (
            <Skeleton rows={4} />
          ) : (events.data?.items.length ?? 0) === 0 ? (
            <EmptyState>Aucun événement.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Événement</th>
                  <th>Gravité</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {events.data!.items.map((event) => (
                  <tr key={event.id}>
                    <td>{securityTypeLabel(event.type)}</td>
                    <td>
                      <Badge tone={severityTone(event.severity)}>{event.severity}</Badge>
                    </td>
                    <td className="text-xs">{formatDateTime(event.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <dt className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * Politique d'applications, telle que CE téléphone la vit.
 *
 * La carte compare deux choses que le reste de l'interface tient séparées : ce
 * que l'administration a demandé, et ce que l'appareil rapporte avoir fait. Un
 * écart entre les deux est l'information la plus utile de cette page — c'est un
 * blocage affiché quelque part et qui n'existe nulle part.
 *
 * Tant qu'aucun constat n'est remonté, elle ne dit rien de rassurant : elle dit
 * qu'elle ne sait pas.
 */
function AppPolicyCard({
  report,
  requested,
}: {
  report: AppPolicyReport | null;
  requested: Record<string, unknown>;
}) {
  const demandes = Array.isArray(requested.blockedApps)
    ? (requested.blockedApps as string[])
    : [];

  return (
    <Card
      title="Politique d’applications"
      className="mt-4"
      action={
        <Link
          href="/devices/apps"
          className="text-xs"
          style={{ color: 'var(--color-accent)' }}
        >
          Modifier la consigne
        </Link>
      }
    >
      {report === null ? (
        <EmptyState>
          Ce téléphone n’a encore rien rapporté. On ne sait donc pas ce qu’il
          masque — et {demandes.length > 0
            ? `les ${demandes.length} application(s) demandées ne sont pas confirmées bloquées.`
            : 'aucune application n’est demandée pour l’instant.'}
        </EmptyState>
      ) : (
        <div className="space-y-4 p-5">
          {!report.enforced && (
            <div
              className="rounded-lg px-4 py-3 text-sm"
              style={{
                background: 'var(--color-danger-soft)',
                color: 'var(--color-danger)',
              }}
              role="status"
            >
              <strong>Aucune application n’est masquée sur ce téléphone.</strong>{' '}
              L’application n’y est pas administrateur de l’appareil : la consigne
              est reçue mais reste sans effet. Ce privilège s’accorde à la mise en
              service, jamais après coup.
            </div>
          )}

          <div>
            <span className="label">Réellement masquées</span>
            {report.hidden.length === 0 ? (
              <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
                Aucune.
              </p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {report.hidden.map((pkg) => (
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
            )}
          </div>

          {report.refusals.length > 0 && (
            <div>
              <span className="label">Non appliquées</span>
              <ul className="mt-1 space-y-1">
                {report.refusals.map((refusal) => (
                  <li
                    key={`${refusal.packageName}-${refusal.reason}`}
                    className="text-sm"
                  >
                    <span className="mono text-xs">{refusal.packageName}</span>
                    <span
                      className="ml-2 text-xs"
                      style={{ color: 'var(--color-ink-muted)' }}
                    >
                      {refusalLabel(refusal.reason)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            Constat rapporté {formatAge(report.appliedAt)}, pour la version de
            configuration {report.configVersion}.
          </p>
        </div>
      )}
    </Card>
  );
}

/**
 * Chaque motif est traduit en conséquence concrète, pas en jargon. Un opérateur
 * doit pouvoir décider quoi faire sans connaître l'API Android.
 */
function refusalLabel(reason: AppPolicyReport['refusals'][number]['reason']): string {
  switch (reason) {
    case 'SELF':
      return 'ignorée : c’est l’application de gestion elle-même.';
    case 'PROTECTED':
      return 'refusée : la masquer rendrait le téléphone inutilisable.';
    case 'NOT_INSTALLED':
      return 'absente de ce téléphone — vérifiez le nom du paquet.';
    case 'CONFLICT':
      return 'présente dans les deux listes : bloquée, corrigez la consigne.';
    case 'SYSTEM_REFUSED':
      return 'Android a refusé le masquage sur ce modèle.';
  }
}
