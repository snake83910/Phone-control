'use client';

import { use, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DepotDetail } from '@/lib/api';
import {
  Badge,
  Card,
  ErrorState,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';

interface FormState {
  name: string;
  returnTime: string;
  lockTime: string;
  operationalDayStart: string;
  timezone: string;
  radiusMeters: number;
  exitHysteresisMeters: number;
  latitude: number;
  longitude: number;
}

export default function DepotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const depot = useQuery({
    queryKey: ['depots', id],
    queryFn: () => api<DepotDetail>(`/v1/depots/${id}`),
  });

  useEffect(() => {
    if (depot.data && !form) {
      setForm({
        name: depot.data.name,
        returnTime: depot.data.returnTime,
        lockTime: depot.data.lockTime,
        operationalDayStart: depot.data.operationalDayStart,
        timezone: depot.data.timezone,
        radiusMeters: depot.data.radiusMeters,
        exitHysteresisMeters: depot.data.exitHysteresisMeters,
        latitude: depot.data.latitude,
        longitude: depot.data.longitude,
      });
    }
  }, [depot.data, form]);

  const save = useMutation({
    mutationFn: (payload: FormState) =>
      api(`/v1/depots/${id}`, { method: 'PATCH', body: payload }),
    onSuccess: () => {
      setMessage(
        'Dépôt enregistré. Les téléphones appliqueront les nouvelles règles à leur prochaine synchronisation.',
      );
      void queryClient.invalidateQueries({ queryKey: ['depots'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  if (depot.isError) return <ErrorState message={(depot.error as Error).message} />;
  if (!depot.data || !form) return <Skeleton rows={8} />;

  const d = depot.data;

  return (
    <>
      <PageHeader
        title={d.name}
        description={`${d.code} · ${d.timezone}`}
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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Règles du jour" className="lg:col-span-1">
          <dl className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            <Row label="Jour opérationnel">
              <span className="mono">{d.today.operationalDay}</span>
            </Row>
            <Row label="Heure de retour">
              {d.today.rules.returnTime ? (
                <span className="mono">{d.today.rules.returnTime}</span>
              ) : (
                <Badge tone="idle">Aucune règle</Badge>
              )}
            </Row>
            <Row label="Heure de verrouillage">
              {d.today.rules.lockTime ? (
                <span className="mono">{d.today.rules.lockTime}</span>
              ) : (
                <Badge tone="idle">Aucune règle</Badge>
              )}
            </Row>
            <Row label="Prochain verrouillage">
              {d.today.nextLockInstant ? formatDateTime(d.today.nextLockInstant) : '—'}
            </Row>
          </dl>
          <p
            className="px-5 py-3 text-xs"
            style={{ color: 'var(--color-ink-faint)', borderTop: '1px solid var(--color-border)' }}
          >
            Ces valeurs sont calculées par le serveur après application des
            surcharges (jour de semaine, jour férié, période spéciale) et du
            fuseau du dépôt.
          </p>
        </Card>

        <Card title="Configuration" className="lg:col-span-2">
          <form
            className="grid gap-4 p-5 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(form);
            }}
          >
            <Field label="Nom">
              <input
                className="field"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>

            <Field label="Fuseau horaire (IANA)">
              <input
                className="field mono"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              />
            </Field>

            <Field label="Heure de retour">
              <input
                className="field mono"
                type="time"
                value={form.returnTime}
                onChange={(e) => setForm({ ...form, returnTime: e.target.value })}
              />
            </Field>

            <Field label="Heure de verrouillage">
              <input
                className="field mono"
                type="time"
                value={form.lockTime}
                onChange={(e) => setForm({ ...form, lockTime: e.target.value })}
              />
            </Field>

            <Field
              label="Début du jour opérationnel"
              hint="Rattache un verrouillage après minuit à la bonne journée."
            >
              <input
                className="field mono"
                type="time"
                value={form.operationalDayStart}
                onChange={(e) =>
                  setForm({ ...form, operationalDayStart: e.target.value })
                }
              />
            </Field>

            <Field label="Rayon du geofence (m)">
              <input
                className="field mono"
                type="number"
                min={50}
                max={5000}
                value={form.radiusMeters}
                onChange={(e) =>
                  setForm({ ...form, radiusMeters: Number(e.target.value) })
                }
              />
            </Field>

            <Field
              label="Marge de sortie (m)"
              hint="Rend la sortie plus exigeante que l’entrée."
            >
              <input
                className="field mono"
                type="number"
                min={0}
                max={2000}
                value={form.exitHysteresisMeters}
                onChange={(e) =>
                  setForm({ ...form, exitHysteresisMeters: Number(e.target.value) })
                }
              />
            </Field>

            <Field label="Latitude">
              <input
                className="field mono"
                type="number"
                step="0.000001"
                value={form.latitude}
                onChange={(e) => setForm({ ...form, latitude: Number(e.target.value) })}
              />
            </Field>

            <Field label="Longitude">
              <input
                className="field mono"
                type="number"
                step="0.000001"
                value={form.longitude}
                onChange={(e) => setForm({ ...form, longitude: Number(e.target.value) })}
              />
            </Field>

            <div className="sm:col-span-2">
              <button className="btn btn-primary" disabled={save.isPending}>
                {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </button>
              <p className="mt-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
                Toute modification de position ou de rayon est propagée au
                geofence : sans cela, la correction resterait sans effet sur les
                téléphones.
              </p>
            </div>
          </form>
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && (
        <span className="mt-1 block text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {hint}
        </span>
      )}
    </label>
  );
}
