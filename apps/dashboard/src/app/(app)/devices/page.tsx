'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type DepotRow,
  type DeviceSummary,
  type Paginated,
} from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
  deviceStateTone,
} from '@/components/ui';
import { deviceStateLabel, formatAge, fullName } from '@/lib/format';

const TAKE = 50;

/**
 * Format imposé par le serveur : majuscules, chiffres et tirets.
 *
 * Contrôlé ici aussi, pour que la faute se voie à la frappe plutôt qu'au
 * retour du serveur — un identifiant d'inventaire se saisit à la chaîne, en
 * regardant l'étiquette collée au dos de l'appareil, pas l'écran.
 */
const ASSET_TAG = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

export default function DevicesPage() {
  const queryClient = useQueryClient();
  const [skip, setSkip] = useState(0);
  const [state, setState] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [assetTag, setAssetTag] = useState('');
  const [depotId, setDepotId] = useState('');

  const query = useQuery({
    queryKey: ['devices', 'list', skip, state],
    queryFn: () =>
      api<Paginated<DeviceSummary>>(
        `/v1/devices?take=${TAKE}&skip=${skip}${state ? `&state=${state}` : ''}`,
      ),
  });

  const depots = useQuery({
    queryKey: ['depots', 'list'],
    queryFn: () => api<DepotRow[]>('/v1/depots'),
  });

  /**
   * Déclaration d'un téléphone, avant son provisioning.
   *
   * L'appareil n'existe encore que sur une étiquette d'inventaire : il n'a ni
   * numéro de série, ni IMEI, ni Device Owner. Tout cela remonte à
   * l'enrôlement, quand le téléphone parle pour la première fois. Le déclarer
   * ici, c'est seulement lui réserver une place — et rendre possible la
   * génération de son QR code de mise en service.
   */
  const create = useMutation({
    mutationFn: () =>
      api<DeviceSummary>('/v1/devices', {
        method: 'POST',
        body: {
          assetTag: assetTag.trim().toUpperCase(),
          ...(depotId ? { depotId } : {}),
        },
      }),
    onSuccess: (device) => {
      setAssetTag('');
      setMessage(
        `${device.assetTag} est déclaré. Générez son QR code depuis « Mise en ` +
          'service » : c’est lui qui lui donnera son identité et le mode kiosque.',
      );
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const normalized = assetTag.trim().toUpperCase();
  const canSubmit = ASSET_TAG.test(normalized);

  return (
    <>
      <PageHeader
        title="Téléphones"
        description="État, porteur, dernière position et santé matérielle."
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

      <Card title="Déclarer un téléphone" className="mb-4">
        <form
          className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <label className="block">
            <span className="label">Identifiant d’inventaire</span>
            <input
              className="field mono mt-1 w-full"
              value={assetTag}
              onChange={(e) => setAssetTag(e.target.value)}
              placeholder="TEL-023"
              required
            />
          </label>

          <label className="block">
            <span className="label">Dépôt (facultatif)</span>
            <select
              className="field mt-1 w-full"
              value={depotId}
              onChange={(e) => setDepotId(e.target.value)}
            >
              <option value="">Aucun</option>
              {(depots.data ?? []).map((depot) => (
                <option key={depot.id} value={depot.id}>
                  {depot.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button
              className="btn btn-primary w-full"
              disabled={!canSubmit || create.isPending}
            >
              {create.isPending ? 'Enregistrement…' : 'Déclarer'}
            </button>
          </div>
        </form>

        <p
          className="px-5 pb-4 text-xs"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          {normalized.length > 0 && !canSubmit
            ? 'Majuscules, chiffres et tirets, de 2 à 32 caractères — par exemple TEL-023.'
            : 'Le téléphone n’a encore aucune identité : marque, numéro de série et ' +
              'mode kiosque remontent à l’enrôlement, pas ici.'}
        </p>
      </Card>

      <Card
        action={
          <select
            className="field w-auto"
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setSkip(0);
            }}
            aria-label="Filtrer par état"
          >
            <option value="">Tous les états</option>
            <option value="ACTIVE">Actif</option>
            <option value="RETURNED">Retourné</option>
            <option value="LOCKED">Verrouillé</option>
            <option value="UNKNOWN">Inconnu</option>
          </select>
        }
        title={`${query.data?.total ?? '—'} téléphone(s)`}
      >
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={6} />}

        {query.data && query.data.items.length === 0 && (
          <EmptyState>Aucun téléphone ne correspond à ce filtre.</EmptyState>
        )}

        {query.data && query.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Identifiant</th>
                  <th>État</th>
                  <th>Chauffeur</th>
                  <th>Dépôt</th>
                  <th>Batterie</th>
                  <th>Dernier contact</th>
                  <th>Device Owner</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <Link
                        href={`/devices/${device.id}`}
                        className="mono font-medium"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {device.assetTag}
                      </Link>
                      <div className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
                        {[device.manufacturer, device.model].filter(Boolean).join(' ') || '—'}
                      </div>
                    </td>
                    <td>
                      <Badge tone={deviceStateTone(device.state)}>
                        {deviceStateLabel(device.state)}
                      </Badge>
                      {device.enrollmentStatus !== 'ENROLLED' && (
                        <div className="mt-1">
                          <Badge tone="idle">{device.enrollmentStatus}</Badge>
                        </div>
                      )}
                    </td>
                    <td>
                      {device.currentSession ? (
                        <Link
                          href={`/users/${device.currentSession.user.id}`}
                          style={{ color: 'var(--color-accent)' }}
                        >
                          {fullName(device.currentSession.user)}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--color-ink-faint)' }}>—</span>
                      )}
                    </td>
                    <td>{device.depot?.name ?? '—'}</td>
                    <td className="mono">
                      {device.battery == null ? (
                        '—'
                      ) : (
                        <span
                          style={{
                            color:
                              device.battery <= 15 && !device.charging
                                ? 'var(--color-warn)'
                                : undefined,
                          }}
                        >
                          {device.battery}%{device.charging ? ' ⚡' : ''}
                        </span>
                      )}
                    </td>
                    <td className="text-xs">{formatAge(device.lastSeenAt)}</td>
                    <td>
                      {/* Jamais présenté comme acquis : sans confirmation de
                          l'appareil, le kiosque n'est pas garanti. */}
                      {device.deviceOwnerActive ? (
                        <Badge tone="ok">Confirmé</Badge>
                      ) : (
                        <Badge tone="warn">Non confirmé</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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
