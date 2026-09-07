'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type DeviceSummary, type Paginated } from '@/lib/api';
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

/**
 * Mise en service : QR codes de provisioning Device Owner.
 *
 * Un QR code par téléphone, à scanner sur l'écran de bienvenue d'un terminal
 * réinitialisé. Il installe l'application, lui attribue le rôle Device Owner et
 * transporte le jeton qui rattache le téléphone à son entreprise et à son dépôt
 * — sans aucune saisie sur l'écran.
 *
 * Cette page couvre l'unité et la petite série. Pour un parc entier, l'outil
 * d'atelier produit une planche PDF et un manifeste (voir docs/12).
 */

interface ProvisioningLabel {
  deviceId: string;
  assetTag: string;
  depotName: string | null;
  kioskMode: string | null;
  expiresAt: string;
  maskedToken: string;
  svg: string;
  payloadBytes: number;
  printSizeMm: number;
}

interface GenerateResponse {
  labels: ProvisioningLabel[];
  warnings: string[];
}

interface GenerateFailure {
  message: string;
  problems?: string[];
  emitted?: number;
}

const MAX_DEVICES = 60;

export default function ProvisioningPage() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState<ProvisioningLabel[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [failure, setFailure] = useState<GenerateFailure | null>(null);

  const devices = useQuery({
    queryKey: ['devices', 'provisioning'],
    queryFn: () => api<Paginated<DeviceSummary>>('/v1/devices?take=200'),
  });

  const generate = useMutation({
    mutationFn: async (deviceIds: string[]): Promise<GenerateResponse> => {
      const response = await fetch('/api/provisioning', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceIds }),
        credentials: 'same-origin',
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) throw payload ?? { message: `Erreur ${response.status}` };
      return payload as GenerateResponse;
    },
    onSuccess: (data) => {
      setLabels(data.labels);
      setWarnings(data.warnings);
      setFailure(null);
    },
    onError: (error) => setFailure(error as GenerateFailure),
  });

  const rows = devices.data?.items ?? [];

  const awaiting = useMemo(
    () => rows.filter((device) => device.enrollmentStatus === 'PENDING'),
    [rows],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (devices.isError) return <ErrorState message={(devices.error as Error).message} />;

  return (
    <>
      <style>{PRINT_STYLES}</style>

      <div className="no-print">
        <PageHeader
          title="Mise en service"
          description="QR codes de provisioning Device Owner, à scanner sur un téléphone réinitialisé."
          action={
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-secondary"
                disabled={awaiting.length === 0}
                onClick={() => setSelected(new Set(awaiting.map((device) => device.id)))}
              >
                Sélectionner les {awaiting.length} en attente
              </button>
              <button
                className="btn btn-primary"
                disabled={selected.size === 0 || generate.isPending}
                onClick={() => generate.mutate([...selected])}
              >
                {generate.isPending
                  ? 'Émission des jetons…'
                  : `Générer ${selected.size || ''} QR code${selected.size > 1 ? 's' : ''}`}
              </button>
            </div>
          }
        />

        <div
          className="mb-4 rounded-lg px-4 py-3 text-sm"
          style={{
            background: 'var(--color-warn-soft)',
            color: 'var(--color-warn)',
            border: '1px solid var(--color-warn)',
          }}
          role="note"
        >
          <strong>Chaque QR code contient un jeton d’enrôlement.</strong> Il est à
          usage unique et daté, mais quiconque le photographie avant qu’il ne soit
          consommé peut rattacher un téléphone à votre entreprise. Imprimez, collez,
          et ne diffusez pas cette page.
        </div>

        {failure && (
          <div
            className="mb-4 rounded-lg px-4 py-3 text-sm"
            style={{
              background: 'var(--color-danger-soft)',
              color: 'var(--color-danger)',
              border: '1px solid var(--color-danger)',
            }}
            role="alert"
          >
            <strong>{failure.message}</strong>
            {failure.problems && (
              <ul className="mt-2 list-disc pl-5">
                {failure.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            {failure.emitted != null && failure.emitted > 0 && (
              <p className="mt-2">
                {failure.emitted} jeton(s) avaient déjà été émis avant l’échec : ils
                restent valables et apparaîtront comme utilisés s’ils sont scannés.
              </p>
            )}
          </div>
        )}

        {warnings.length > 0 && (
          <div
            className="mb-4 rounded-lg px-4 py-3 text-sm"
            style={{
              background: 'var(--color-accent-soft)',
              color: 'var(--color-accent)',
            }}
            role="status"
          >
            <ul className="list-disc pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        <Card
          title="Téléphones"
          action={
            <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
              {selected.size} sélectionné(s) · maximum {MAX_DEVICES}
            </span>
          }
        >
          {devices.isLoading ? (
            <Skeleton rows={6} />
          ) : rows.length === 0 ? (
            <EmptyState>
              Aucun téléphone déclaré. Créez-en un avant de le mettre en service.
            </EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '2.5rem' }} />
                  <th>Étiquette</th>
                  <th>Dépôt</th>
                  <th>Mode</th>
                  <th>Enrôlement</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Sélectionner ${device.assetTag}`}
                        checked={selected.has(device.id)}
                        onChange={() => toggle(device.id)}
                      />
                    </td>
                    <td>
                      <Link
                        href={`/devices/${device.id}`}
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {device.assetTag}
                      </Link>
                    </td>
                    <td>{device.depot?.name ?? '—'}</td>
                    <td>{device.kioskMode}</td>
                    <td>
                      <Badge
                        tone={
                          device.enrollmentStatus === 'ENROLLED'
                            ? 'ok'
                            : device.enrollmentStatus === 'PENDING'
                              ? 'warn'
                              : 'idle'
                        }
                      >
                        {enrollmentLabel(device.enrollmentStatus)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {labels.length > 0 && (
        <>
          <div className="no-print mt-6 flex items-center justify-between">
            <h2 className="text-base font-semibold">
              {labels.length} étiquette(s) prête(s)
            </h2>
            <button className="btn btn-secondary" onClick={() => window.print()}>
              Imprimer
            </button>
          </div>

          <div className="labels mt-3 grid gap-3 sm:grid-cols-2">
            {labels.map((label) => (
              <LabelCard key={label.deviceId} label={label} />
            ))}
          </div>

          <p className="no-print mt-4 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Réinitialiser le téléphone, puis appuyer six fois sur l’écran de bienvenue
            pour ouvrir le lecteur de QR code. Détail de la procédure :
            docs/04 §3.
          </p>
        </>
      )}
    </>
  );
}

function LabelCard({ label }: { label: ProvisioningLabel }) {
  return (
    <div
      className="label rounded-lg p-4"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
      }}
    >
      <div className="flex items-start gap-4">
        <div
          className="qr shrink-0"
          // La taille d'impression vient du serveur : elle dépend de la densité
          // réelle du code, pas d'une valeur choisie une fois pour toutes.
          style={
            {
              width: 170,
              height: 170,
              '--qr-print-size': `${label.printSizeMm}mm`,
            } as React.CSSProperties
          }
          // Le SVG vient de notre propre gestionnaire de route, jamais d'une
          // saisie utilisateur : il est construit par la bibliothèque de rendu
          // à partir d'une charge utile que nous avons formée nous-mêmes.
          dangerouslySetInnerHTML={{ __html: label.svg }}
        />
        <dl className="min-w-0 text-sm">
          <dt className="sr-only">Étiquette</dt>
          <dd className="text-lg font-semibold">{label.assetTag}</dd>

          <dt className="mt-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Dépôt
          </dt>
          <dd>{label.depotName ?? 'non affecté'}</dd>

          <dt className="mt-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Mode
          </dt>
          <dd>{label.kioskMode ?? 'KIOSK'}</dd>

          <dt className="mt-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Jeton valable jusqu’au
          </dt>
          <dd>{formatDateTime(label.expiresAt)}</dd>

          <dt className="mt-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Jeton
          </dt>
          <dd className="mono text-xs">{label.maskedToken}</dd>
        </dl>
      </div>
    </div>
  );
}

function enrollmentLabel(status: DeviceSummary['enrollmentStatus']): string {
  switch (status) {
    case 'PENDING':
      return 'À mettre en service';
    case 'ENROLLED':
      return 'Enrôlé';
    case 'REVOKED':
      return 'Révoqué';
    default:
      return 'Retiré';
  }
}

/**
 * Impression.
 *
 * Le navigateur remplace ici la planche PDF de l'outil d'atelier : mêmes
 * étiquettes, même découpe, sans dépendance supplémentaire. Les couleurs sont
 * forcées en noir sur blanc — un QR code imprimé en nuances de gris par une
 * imprimante d'atelier se lit mal.
 */
const PRINT_STYLES = `
@media print {
  .no-print { display: none !important; }
  .labels { display: block !important; }
  .label {
    break-inside: avoid;
    page-break-inside: avoid;
    border: 1px dashed #999 !important;
    background: #fff !important;
    color: #000 !important;
    margin: 0 0 8mm 0;
    padding: 6mm;
  }
  .label .qr {
    width: var(--qr-print-size, 50mm) !important;
    height: var(--qr-print-size, 50mm) !important;
  }
  .label * { color: #000 !important; }
}
.qr svg { width: 100%; height: 100%; display: block; }
`;
