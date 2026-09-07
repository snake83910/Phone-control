'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type DeviceSummary,
  type Paginated,
  type SessionRow,
  type UserDetail,
} from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/format';

export default function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [deviceToAdd, setDeviceToAdd] = useState('');
  const [barcodeToAttach, setBarcodeToAttach] = useState('');

  const user = useQuery({
    queryKey: ['users', id],
    queryFn: () => api<UserDetail>(`/v1/users/${id}`),
  });

  const sessions = useQuery({
    queryKey: ['sessions', 'user', id],
    queryFn: () => api<Paginated<SessionRow>>(`/v1/sessions?userId=${id}&take=10`),
  });

  const devices = useQuery({
    queryKey: ['devices', 'all-for-assignment'],
    queryFn: () => api<Paginated<DeviceSummary>>('/v1/devices?take=200'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['users', id] });
  };

  const setStatus = useMutation({
    mutationFn: (status: string) =>
      api(`/v1/users/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: invalidate,
    onError: (e) => setMessage((e as Error).message),
  });

  const revokeBadge = useMutation({
    mutationFn: (badgeId: string) =>
      api(`/v1/badges/${badgeId}/status`, {
        method: 'POST',
        body: { status: 'REVOKED', reason: 'Révoqué depuis la fiche chauffeur' },
      }),
    onSuccess: () => {
      setMessage(
        'Badge révoqué. Il ne pourra plus ouvrir de session, et disparaîtra des listes hors ligne à la prochaine synchronisation des téléphones.',
      );
      invalidate();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  /**
   * Rattachement d'un badge existant.
   *
   * On ne fabrique pas de badge : le chauffeur en a déjà un dans la poche, avec
   * un numéro imprimé dessus. Tout ce qu'on enregistre ici, c'est que ce
   * numéro-là appartient à cette personne-là.
   *
   * Le numéro saisi n'est jamais renvoyé par l'API ni réaffiché : il est
   * normalisé puis haché à l'enregistrement, et seuls les quatre derniers
   * chiffres restent visibles.
   */
  const attachBadge = useMutation({
    mutationFn: (barcode: string) =>
      api('/v1/badges', { method: 'POST', body: { userId: id, barcode } }),
    onSuccess: () => {
      setBarcodeToAttach('');
      setMessage('Badge rattaché. Il ouvrira une session sur les téléphones autorisés.');
      invalidate();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const assign = useMutation({
    mutationFn: (deviceId: string) =>
      api(`/v1/users/${id}/devices`, { method: 'POST', body: { deviceId } }),
    onSuccess: () => {
      setDeviceToAdd('');
      invalidate();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const unassign = useMutation({
    mutationFn: (deviceId: string) =>
      api(`/v1/users/${id}/devices/${deviceId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
    onError: (e) => setMessage((e as Error).message),
  });

  if (user.isError) return <ErrorState message={(user.error as Error).message} />;
  if (!user.data) return <Skeleton rows={8} />;

  const u = user.data;
  const assignedIds = new Set(u.authorizedDevices.map((d) => d.id));
  const assignable = (devices.data?.items ?? []).filter((d) => !assignedIds.has(d.id));

  return (
    <>
      <PageHeader
        title={`${u.firstName} ${u.lastName}`}
        description={[u.employeeNumber, u.depot?.name].filter(Boolean).join(' · ')}
        action={
          <button
            className="btn btn-secondary"
            disabled={setStatus.isPending}
            onClick={() =>
              setStatus.mutate(u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')
            }
          >
            {u.status === 'ACTIVE' ? 'Désactiver' : 'Réactiver'}
          </button>
        }
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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Identité">
          <dl className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            <Row label="Statut">
              <Badge tone={u.status === 'ACTIVE' ? 'ok' : 'idle'}>{u.status}</Badge>
            </Row>
            <Row label="Matricule">{u.employeeNumber ?? '—'}</Row>
            <Row label="Dépôt">{u.depot?.name ?? '—'}</Row>
            <Row label="Téléphone">{u.phone ?? '—'}</Row>
            <Row label="E-mail">{u.email ?? '—'}</Row>
            <Row label="Dernière session">
              {u.lastSession ? (
                <Link
                  href={`/devices/${u.lastSession.device.id}`}
                  style={{ color: 'var(--color-accent)' }}
                >
                  {formatDateTime(u.lastSession.startedAt)} · {u.lastSession.device.assetTag}
                </Link>
              ) : (
                '—'
              )}
            </Row>
          </dl>
        </Card>

        <Card title="Badges">
          <form
            className="flex flex-wrap items-end gap-2 px-5 pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              const barcode = barcodeToAttach.trim();
              if (barcode.length >= 4) attachBadge.mutate(barcode);
            }}
          >
            <label className="flex-1" style={{ minWidth: '14rem' }}>
              <span
                className="mb-1 block text-xs"
                style={{ color: 'var(--color-ink-muted)' }}
              >
                Numéro imprimé sur le badge du chauffeur
              </span>
              <input
                className="field mono"
                // `autoFocus` volontairement absent : la plupart des douchettes
                // USB tapent le numéro puis valident. Le champ doit être choisi
                // par l'opérateur, pas voler le focus d'une autre saisie.
                inputMode="numeric"
                autoComplete="off"
                placeholder="14557719"
                value={barcodeToAttach}
                onChange={(event) => setBarcodeToAttach(event.target.value)}
              />
            </label>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={attachBadge.isPending || barcodeToAttach.trim().length < 4}
            >
              {attachBadge.isPending ? 'Rattachement…' : 'Rattacher ce badge'}
            </button>
          </form>

          <p
            className="px-5 pt-2 pb-1 text-xs"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            Le badge existe déjà : on enregistre seulement à qui il appartient.
            Le numéro est haché à l’enregistrement — il n’est plus jamais affiché
            en entier, ici ou ailleurs.
          </p>

          {u.badges.length === 0 ? (
            <EmptyState>Aucun badge rattaché à ce chauffeur.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Numéro</th>
                  <th>Statut</th>
                  <th>Émis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {u.badges.map((badge) => (
                  <tr key={badge.id}>
                    <td className="mono">{badge.maskedBarcode}</td>
                    <td>
                      <Badge tone={badge.status === 'ACTIVE' ? 'ok' : 'idle'}>
                        {badge.status}
                      </Badge>
                    </td>
                    <td className="text-xs">{formatDate(badge.issuedAt)}</td>
                    <td className="text-right">
                      {badge.status === 'ACTIVE' && (
                        <button
                          className="btn btn-danger"
                          disabled={revokeBadge.isPending}
                          onClick={() => revokeBadge.mutate(badge.id)}
                        >
                          Révoquer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Téléphones autorisés">
          {u.authorizedDevices.length === 0 ? (
            <EmptyState>
              Aucun téléphone autorisé : tout scan de badge sera refusé.
            </EmptyState>
          ) : (
            <ul>
              {u.authorizedDevices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between px-5 py-2.5"
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  <Link
                    href={`/devices/${device.id}`}
                    className="mono text-sm"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    {device.assetTag}
                  </Link>
                  <button
                    className="btn btn-secondary"
                    disabled={unassign.isPending}
                    onClick={() => unassign.mutate(device.id)}
                  >
                    Retirer
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div
            className="flex gap-2 px-5 py-3"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <select
              className="field"
              value={deviceToAdd}
              onChange={(e) => setDeviceToAdd(e.target.value)}
              aria-label="Téléphone à autoriser"
            >
              <option value="">Ajouter un téléphone…</option>
              {assignable.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.assetTag}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={!deviceToAdd || assign.isPending}
              onClick={() => assign.mutate(deviceToAdd)}
            >
              Autoriser
            </button>
          </div>
        </Card>
      </div>

      <Card title="Historique des sessions" className="mt-4">
        {sessions.isLoading ? (
          <Skeleton rows={4} />
        ) : (sessions.data?.items.length ?? 0) === 0 ? (
          <EmptyState>Aucune session.</EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Téléphone</th>
                <th>Début</th>
                <th>Retour au dépôt</th>
                <th>Fin</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data!.items.map((session) => (
                <tr key={session.id}>
                  <td className="mono">{session.device.assetTag}</td>
                  <td className="text-xs">{formatDateTime(session.startedAt)}</td>
                  <td className="text-xs">
                    {session.returnedAt ? formatDateTime(session.returnedAt) : '—'}
                  </td>
                  <td className="text-xs">
                    {session.endedAt ? formatDateTime(session.endedAt) : '—'}
                  </td>
                  <td>
                    <Badge tone={session.status === 'ACTIVE' ? 'ok' : 'idle'}>
                      {session.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
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
