'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  Badge,
  Card,
  ErrorState,
  PageHeader,
  Skeleton,
} from '@/components/ui';

interface CompanyDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  settings: Record<string, unknown>;
  retentionPolicy: {
    locationEventsDays: number;
    geofenceEventsDays: number;
    securityEventsDays: number;
    sessionsDays: number;
    auditLogsDays: number;
    allowLocateWhenLocked: boolean;
  } | null;
  _count: { devices: number; users: number; admins: number };
}

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () =>
      api<{ companyId: string | null; role: string }>('/v1/auth/me'),
  });

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<CompanyRow[]>('/v1/companies'),
    enabled: profile.data?.role === 'SUPER_ADMIN',
  });

  const companyId =
    profile.data?.companyId ?? companies.data?.[0]?.id ?? null;

  const company = useQuery({
    queryKey: ['companies', companyId],
    queryFn: () => api<CompanyDetail>(`/v1/companies/${companyId}`),
    enabled: Boolean(companyId) && profile.data?.role === 'SUPER_ADMIN',
  });

  const [retention, setRetention] = useState<
    CompanyDetail['retentionPolicy'] | null
  >(null);

  useEffect(() => {
    if (company.data?.retentionPolicy && !retention) {
      setRetention(company.data.retentionPolicy);
    }
  }, [company.data, retention]);

  const save = useMutation({
    mutationFn: (payload: NonNullable<CompanyDetail['retentionPolicy']>) =>
      api(`/v1/companies/${companyId}/retention`, {
        method: 'PATCH',
        body: {
          locationEventsDays: payload.locationEventsDays,
          geofenceEventsDays: payload.geofenceEventsDays,
          securityEventsDays: payload.securityEventsDays,
          sessionsDays: payload.sessionsDays,
          allowLocateWhenLocked: payload.allowLocateWhenLocked,
        },
      }),
    onSuccess: () => {
      setMessage('Politique de conservation enregistrée.');
      void queryClient.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  if (profile.isLoading) return <Skeleton rows={6} />;

  // Seul le SUPER_ADMIN accède aux entreprises et à la rétention : un
  // administrateur d'entreprise voit ses règles, sans pouvoir les changer.
  const isSuperAdmin = profile.data?.role === 'SUPER_ADMIN';

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Conservation des données et réglages d’entreprise."
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

      {!isSuperAdmin ? (
        <Card title="Accès">
          <p className="px-5 py-4 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            La configuration des entreprises et des durées de conservation est
            réservée au super administrateur. Les règles horaires et le rayon des
            geofences se modifient depuis la fiche de chaque dépôt.
          </p>
        </Card>
      ) : company.isError ? (
        <ErrorState message={(company.error as Error).message} />
      ) : !company.data || !retention ? (
        <Skeleton rows={6} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Entreprise">
            <dl className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
              <Row label="Nom">{company.data.name}</Row>
              <Row label="Identifiant">
                <span className="mono text-xs">{company.data.slug}</span>
              </Row>
              <Row label="Statut">
                <Badge tone={company.data.status === 'ACTIVE' ? 'ok' : 'idle'}>
                  {company.data.status}
                </Badge>
              </Row>
              <Row label="Téléphones">{company.data._count.devices}</Row>
              <Row label="Chauffeurs">{company.data._count.users}</Row>
              <Row label="Administrateurs">{company.data._count.admins}</Row>
            </dl>
          </Card>

          <Card title="Conservation des données (RGPD)" className="lg:col-span-2">
            <form
              className="grid gap-4 p-5 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(retention);
              }}
            >
              <Field
                label="Positions GPS (jours)"
                hint="Purgées par suppression de partition mensuelle : la réduction libère réellement l’espace."
              >
                <input
                  className="field mono"
                  type="number"
                  min={1}
                  value={retention.locationEventsDays}
                  onChange={(e) =>
                    setRetention({
                      ...retention,
                      locationEventsDays: Number(e.target.value),
                    })
                  }
                />
              </Field>

              <Field label="Événements de geofence (jours)">
                <input
                  className="field mono"
                  type="number"
                  min={1}
                  value={retention.geofenceEventsDays}
                  onChange={(e) =>
                    setRetention({
                      ...retention,
                      geofenceEventsDays: Number(e.target.value),
                    })
                  }
                />
              </Field>

              <Field label="Événements de sécurité (jours)">
                <input
                  className="field mono"
                  type="number"
                  min={1}
                  value={retention.securityEventsDays}
                  onChange={(e) =>
                    setRetention({
                      ...retention,
                      securityEventsDays: Number(e.target.value),
                    })
                  }
                />
              </Field>

              <Field label="Sessions (jours)">
                <input
                  className="field mono"
                  type="number"
                  min={1}
                  value={retention.sessionsDays}
                  onChange={(e) =>
                    setRetention({
                      ...retention,
                      sessionsDays: Number(e.target.value),
                    })
                  }
                />
              </Field>

              <div className="sm:col-span-2">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={retention.allowLocateWhenLocked}
                    onChange={(e) =>
                      setRetention({
                        ...retention,
                        allowLocateWhenLocked: e.target.checked,
                      })
                    }
                  />
                  <span>
                    <span className="text-sm font-medium">
                      Autoriser la localisation d’un téléphone verrouillé
                    </span>
                    <span
                      className="mt-0.5 block text-xs"
                      style={{ color: 'var(--color-ink-muted)' }}
                    >
                      Point RGPD sensible : hors session, le téléphone n’est plus
                      dans le temps de travail. Désactivé par défaut ; chaque
                      usage est tracé dans le journal d’audit.
                    </span>
                  </span>
                </label>
              </div>

              <div className="sm:col-span-2">
                <button className="btn btn-primary" disabled={save.isPending}>
                  {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </div>
            </form>

            <p
              className="px-5 py-3 text-xs"
              style={{
                color: 'var(--color-ink-faint)',
                borderTop: '1px solid var(--color-border)',
              }}
            >
              Le journal d’audit est conservé {retention.auditLogsDays} jours et
              n’est pas modifiable depuis cette interface : sa durée relève d’une
              décision d’exploitation, pas d’un réglage courant.
            </p>
          </Card>
        </div>
      )}
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
