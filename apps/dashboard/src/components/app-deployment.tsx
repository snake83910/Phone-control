'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DashboardSummary } from '@/lib/api';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export interface AppPackage {
  id: string;
  label: string;
  sha256: string;
  signingCertSha256: string;
  sizeBytes: number;
  packageName: string | null;
  versionName: string | null;
  versionCode: number | null;
  createdAt: string;
  retiredAt: string | null;
  certificate: {
    subject: string;
    validTo: string | null;
    expired: boolean;
  } | null;
}

const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

/**
 * Déploiement d'applications sur la flotte.
 *
 * L'interface dit trois choses que rien d'autre ne dit, et qui décident de
 * l'usage qu'on en fait :
 *
 * 1. **Le serveur calcule les empreintes lui-même.** Elles sont affichées après
 *    dépôt, pas saisies. Une empreinte fournie par celui qui dépose le fichier
 *    ne vérifierait rien.
 * 2. **Le certificat de signature est montré.** L'opérateur voit qui a signé
 *    l'APK avant de l'envoyer sur deux mille téléphones.
 * 3. **Déployer demande une confirmation nominative.** Le nombre de téléphones
 *    concernés est écrit en toutes lettres : c'est la dernière occasion de
 *    remarquer qu'on s'apprêtait à en toucher deux mille au lieu d'un.
 */
export function AppDeploymentCard() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const packages = useQuery({
    queryKey: ['app-packages'],
    queryFn: () => api<AppPackage[]>('/v1/app-packages'),
  });

  // Le nombre d'appareils vient du résumé, pas d'une énumération : une flotte
  // de deux mille téléphones ne tient pas dans une page de liste, et c'est le
  // serveur qui résout la cible au moment du déploiement.
  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => api<DashboardSummary>('/v1/dashboard/summary'),
  });

  const enrolledCount = summary.data?.devices.enrolled ?? 0;

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // Le corps de la requête EST l'APK : pas de formulaire multipart pour un
      // seul fichier. Le libellé voyage en paramètre.
      const response = await fetch(
        `/api/proxy/v1/app-packages?label=${encodeURIComponent(label.trim())}`,
        {
          method: 'POST',
          headers: { 'content-type': APK_CONTENT_TYPE },
          body: file,
        },
      );
      const body = (await response.json()) as AppPackage & { message?: string };
      if (!response.ok) {
        throw new Error(
          Array.isArray(body.message) ? body.message.join(' ') : body.message,
        );
      }
      return body;
    },
    onSuccess: (created) => {
      setError(null);
      setLabel('');
      if (fileInput.current) fileInput.current.value = '';
      setMessage(
        `${created.label} déposé — ${megabytes(created.sizeBytes)}, signé par ` +
          `${created.certificate?.subject ?? 'un certificat non résumé'}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['app-packages'] });
    },
    onError: (e) => {
      setMessage(null);
      setError((e as Error).message);
    },
  });

  const deploy = useMutation({
    mutationFn: (id: string) =>
      api<{ queued: number }>(`/v1/app-packages/${id}/deploy`, {
        method: 'POST',
        // Aucun identifiant : le serveur vise tous les téléphones enrôlés.
        body: {},
      }),
    onSuccess: (result) => {
      setError(null);
      setConfirming(null);
      setMessage(
        `Installation demandée sur ${result.queued} téléphone(s). Chacun ` +
          'vérifiera l’empreinte et la signature avant d’installer, et ' +
          'rapportera ce qu’il a fait.',
      );
    },
    onError: (e) => {
      setConfirming(null);
      setError((e as Error).message);
    },
  });

  const retire = useMutation({
    mutationFn: (id: string) =>
      api<AppPackage>(`/v1/app-packages/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setMessage('Application retirée : le fichier a été supprimé du serveur.');
      void queryClient.invalidateQueries({ queryKey: ['app-packages'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <Card title="Déployer une application" className="mt-4">
      <div className="space-y-4 p-5">
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          L’application est installée <strong>sans rien demander au chauffeur</strong>.
          Le serveur calcule l’empreinte du fichier et celle du certificat de
          signature ; chaque téléphone vérifie les deux avant d’installer, et
          refuse si l’une ne correspond pas.
        </p>

        {message && (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{
              background: 'var(--color-accent-soft)',
              color: 'var(--color-accent)',
            }}
            role="status"
          >
            {message}
          </div>
        )}

        {error && <ErrorState message={error} />}

        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const file = fileInput.current?.files?.[0];
            if (file && label.trim().length >= 2) upload.mutate(file);
          }}
        >
          <label className="block">
            <span className="label">Nom</span>
            <input
              className="field mt-1 w-full"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Application de tournées 2.4"
              required
            />
          </label>

          <label className="block">
            <span className="label">Fichier APK</span>
            <input
              ref={fileInput}
              className="field mt-1 w-full"
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              required
            />
          </label>

          <div className="flex items-end">
            <button
              className="btn btn-primary w-full"
              disabled={upload.isPending || label.trim().length < 2}
            >
              {upload.isPending ? 'Envoi…' : 'Déposer'}
            </button>
          </div>
        </form>

        {packages.isLoading && <Skeleton rows={3} />}

        {packages.data && packages.data.length === 0 && (
          <EmptyState>Aucune application déposée.</EmptyState>
        )}

        {packages.data && packages.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Signée par</th>
                  <th>Empreinte</th>
                  <th>Taille</th>
                  <th>Déposée</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {packages.data.map((pkg) => (
                  <tr key={pkg.id}>
                    <td>
                      <div className="font-medium">{pkg.label}</div>
                      <div
                        className="mono text-xs"
                        style={{ color: 'var(--color-ink-faint)' }}
                      >
                        {pkg.packageName
                          ? `${pkg.packageName}${pkg.versionName ? ` · ${pkg.versionName}` : ''}`
                          : 'paquet inconnu tant qu’aucun téléphone n’a installé'}
                      </div>
                    </td>
                    <td className="text-xs">
                      {pkg.certificate?.subject ?? '—'}
                      {pkg.certificate?.expired && (
                        <span
                          className="ml-1"
                          style={{ color: 'var(--color-warn)' }}
                          title="Certificat expiré. Android l’accepte encore, mais l’éditeur devrait le renouveler."
                        >
                          (expiré)
                        </span>
                      )}
                    </td>
                    <td className="mono text-xs">{pkg.sha256.slice(0, 12)}…</td>
                    <td>{megabytes(pkg.sizeBytes)}</td>
                    <td className="text-xs">{formatDateTime(pkg.createdAt)}</td>
                    <td>
                      {pkg.retiredAt ? (
                        <span
                          className="text-xs"
                          style={{ color: 'var(--color-ink-faint)' }}
                        >
                          retirée
                        </span>
                      ) : confirming === pkg.id ? (
                        <div className="flex gap-2">
                          <button
                            className="btn btn-primary"
                            onClick={() => deploy.mutate(pkg.id)}
                            disabled={deploy.isPending}
                          >
                            Installer sur {enrolledCount}
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => setConfirming(null)}
                          >
                            Annuler
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            className="btn btn-secondary"
                            onClick={() => setConfirming(pkg.id)}
                            disabled={enrolledCount === 0}
                          >
                            Déployer
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={() => retire.mutate(pkg.id)}
                          >
                            Retirer
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {confirming && (
          <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
            Cette application sera installée sur{' '}
            <strong>{enrolledCount} téléphone(s) enrôlé(s)</strong>, sans
            intervention des chauffeurs. Les téléphones sans Device Owner la
            refuseront et le diront.
          </p>
        )}
      </div>
    </Card>
  );
}
