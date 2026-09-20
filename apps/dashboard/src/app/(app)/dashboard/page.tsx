'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api, type ActivityPoint, type AlertRow, type DashboardSummary, type Paginated } from '@/lib/api';
import { ActivityChart } from '@/components/activity-chart';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Stat,
  severityTone,
} from '@/components/ui';
import { alertTypeLabel, formatAge } from '@/lib/format';

export default function DashboardPage() {
  // Un super-administrateur n'est rattaché à aucune entreprise : il en crée,
  // mais ne pilote aucune flotte. C'est pourtant le seul compte qui existe
  // après une installation neuve — la page d'accueil doit donc lui dire quoi
  // faire, et non lui présenter des compteurs vides ou une erreur.
  const profile = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api<{ companyId: string | null; role: string }>('/v1/auth/me'),
  });

  const rattache = profile.data ? profile.data.companyId !== null : true;

  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => api<DashboardSummary>('/v1/dashboard/summary'),
    refetchInterval: 60_000,
    enabled: rattache,
  });

  const activity = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: () => api<ActivityPoint[]>('/v1/dashboard/activity?days=7'),
    enabled: rattache,
  });

  const alerts = useQuery({
    queryKey: ['alerts', 'recent'],
    queryFn: () => api<Paginated<AlertRow>>('/v1/alerts?status=OPEN&take=6'),
    enabled: rattache,
  });

  if (!rattache) {
    return (
      <>
        <PageHeader
          title="Première mise en service"
          description="Ce compte administre l’installation, pas une flotte."
        />
        <Card title="Créer la première entreprise">
          <div
            className="space-y-3 p-5 text-sm"
            style={{ color: 'var(--color-ink-muted)' }}
          >
            <p>
              Vous êtes connecté en super-administrateur. Ce compte crée les
              entreprises et leurs administrateurs ; il ne pilote lui-même aucun
              téléphone, aucun chauffeur, aucun dépôt.
            </p>
            <p>Quatre étapes, dans cet ordre :</p>
            <ol className="ml-5 list-decimal space-y-1">
              <li>
                Créer l’entreprise, par l’API{' '}
                <code className="mono text-xs">POST /v1/companies</code> — elle
                reçoit du même coup ses durées de conservation et sa
                configuration d’appareils. Elle apparaît ensuite dans{' '}
                <Link href="/settings" style={{ color: 'var(--color-accent)' }}>
                  Paramètres
                </Link>
                .
              </li>
              <li>
                La rattacher au compte Trajelys du client, par{' '}
                <code className="mono text-xs">
                  PATCH /v1/companies/&lt;id&gt;/trajelys
                </code>
                . C’est ce rattachement qui autorise l’accès.
              </li>
              <li>
                Ouvrir le module Téléphones sur son compte Trajelys. C’est là
                que vit l’abonnement : sans lui, Trajelys refuse d’émettre le
                code d’ouverture, quel que soit le rattachement posé ici.
              </li>
              <li>
                Le client ouvre Phone Control depuis Trajelys — menu{' '}
                <span className="whitespace-nowrap">Gestion → Téléphones</span>.
                Son compte administrateur est créé à cette occasion : il n’y a
                rien à saisir ici, et aucun second mot de passe à lui
                transmettre.
              </li>
            </ol>
            <p>
              Il n’existe volontairement aucun autre moyen de créer un
              administrateur d’entreprise. Phone Control se vend comme un
              module de Trajelys : le rattachement est la décision
              commerciale, et l’accès en découle.
            </p>
          </div>
        </Card>
      </>
    );
  }

  if (summary.isError) {
    return <ErrorState message={(summary.error as Error).message} />;
  }

  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Vue d’ensemble"
        description={
          s
            ? `Dernière actualisation ${formatAge(s.generatedAt)}`
            : 'Chargement des indicateurs…'
        }
      />

      {!s ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card">
              <Skeleton rows={2} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Téléphones enrôlés"
              value={s.devices.enrolled}
              hint={`${s.devices.pending} en attente de provisioning`}
            />
            <Stat
              label="En session"
              value={s.devices.active}
              tone="ok"
              hint={`${s.devices.locked} verrouillés · ${s.devices.returned} au dépôt`}
            />
            <Stat
              label="Alertes ouvertes"
              value={s.alerts.open}
              tone={s.alerts.open > 0 ? 'danger' : undefined}
              hint={`${s.alerts.today} émise(s) aujourd’hui`}
            />
            <Stat
              label="Hors ligne"
              value={s.devices.offline}
              tone={s.devices.offline > 0 ? 'warn' : undefined}
              hint="Sans signal au-delà du seuil configuré"
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Chauffeurs actifs" value={s.users.active} />
            <Stat
              label="Non retournés"
              value={s.sessions.notReturned}
              hint="Sessions ouvertes sans passage au dépôt"
            />
            <Stat
              label="Batterie faible"
              value={s.health.lowBattery}
              tone={s.health.lowBattery > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Device Owner non confirmé"
              value={s.devices.deviceOwnerUnconfirmed}
              tone={s.devices.deviceOwnerUnconfirmed > 0 ? 'warn' : undefined}
              hint="Kiosque non garanti sur ces appareils"
            />
          </div>
        </>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Activité — 7 derniers jours" className="lg:col-span-2">
          {activity.isLoading ? (
            <Skeleton rows={3} />
          ) : (
            <ActivityChart points={activity.data ?? []} />
          )}
        </Card>

        <Card
          title="Alertes ouvertes"
          action={
            <Link href="/alerts" className="text-xs" style={{ color: 'var(--color-accent)' }}>
              Tout voir
            </Link>
          }
        >
          {alerts.isLoading ? (
            <Skeleton rows={4} />
          ) : (alerts.data?.items.length ?? 0) === 0 ? (
            <EmptyState>Aucune alerte ouverte.</EmptyState>
          ) : (
            <ul>
              {alerts.data!.items.map((alert) => (
                <li
                  key={alert.id}
                  className="px-5 py-3"
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={severityTone(alert.severity)}>
                      {alertTypeLabel(alert.type)}
                    </Badge>
                    <span
                      className="ml-auto text-xs"
                      style={{ color: 'var(--color-ink-faint)' }}
                    >
                      {formatAge(alert.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm">{alert.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
