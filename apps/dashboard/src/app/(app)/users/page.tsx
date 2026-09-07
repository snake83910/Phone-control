'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type DepotRow,
  type Paginated,
  type UserSummary,
} from '@/lib/api';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
} from '@/components/ui';

const TAKE = 50;

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    firstName: '',
    lastName: '',
    employeeNumber: '',
    depotId: '',
  });

  const query = useQuery({
    queryKey: ['users', 'list', search, status, skip],
    queryFn: () => {
      const params = new URLSearchParams({ take: String(TAKE), skip: String(skip) });
      if (search) params.set('search', search);
      if (status) params.set('status', status);
      return api<Paginated<UserSummary>>(`/v1/users?${params.toString()}`);
    },
  });

  const depots = useQuery({
    queryKey: ['depots', 'list'],
    queryFn: () => api<DepotRow[]>('/v1/depots'),
  });

  /**
   * Création d'un chauffeur.
   *
   * Deux champs suffisent : un nom, un prénom. Le matricule et le dépôt sont
   * facultatifs côté serveur, et le rester ici évite qu'un chauffeur embauché
   * ce matin attende son matricule pour exister dans le système.
   *
   * Le badge ne se saisit pas ici. Il se rattache ensuite, depuis la fiche du
   * chauffeur ou depuis la page Badges — parce que la carte physique existe
   * déjà et n'arrive pas forcément en même temps que la personne.
   */
  const create = useMutation({
    mutationFn: (input: typeof draft) =>
      api<UserSummary>('/v1/users', {
        method: 'POST',
        body: {
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          ...(input.employeeNumber.trim()
            ? { employeeNumber: input.employeeNumber.trim() }
            : {}),
          ...(input.depotId ? { depotId: input.depotId } : {}),
        },
      }),
    onSuccess: (user) => {
      // Le dépôt reste sélectionné : on saisit une équipe entière d'un coup,
      // rarement une personne isolée.
      setDraft({
        firstName: '',
        lastName: '',
        employeeNumber: '',
        depotId: draft.depotId,
      });
      // Formulation sans accord : un prenom ne dit pas le genre de la personne,
      // et « enregistre(e) » sur une fiche du personnel se remarque.
      setMessage(
        `Chauffeur ajouté : ${user.firstName} ${user.lastName}. Reste à lui ` +
          'rattacher un badge — sans badge, aucune session ne peut s’ouvrir.',
      );
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const canSubmit =
    draft.firstName.trim().length > 0 && draft.lastName.trim().length > 0;

  return (
    <>
      <PageHeader
        title="Chauffeurs"
        description="Les numéros de badge ne sont jamais affichés en entier."
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

      <Card title="Ajouter un chauffeur" className="mb-4">
        <form
          className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate(draft);
          }}
        >
          <label className="block">
            <span className="label">Prénom</span>
            <input
              className="field mt-1 w-full"
              value={draft.firstName}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
              required
            />
          </label>

          <label className="block">
            <span className="label">Nom</span>
            <input
              className="field mt-1 w-full"
              value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
              required
            />
          </label>

          <label className="block">
            <span className="label">Matricule (facultatif)</span>
            <input
              className="field mono mt-1 w-full"
              value={draft.employeeNumber}
              onChange={(e) =>
                setDraft({ ...draft, employeeNumber: e.target.value })
              }
              placeholder="MAT-0421"
            />
          </label>

          <label className="block">
            <span className="label">Dépôt (facultatif)</span>
            <select
              className="field mt-1 w-full"
              value={draft.depotId}
              onChange={(e) => setDraft({ ...draft, depotId: e.target.value })}
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
              {create.isPending ? 'Enregistrement…' : 'Ajouter'}
            </button>
          </div>
        </form>

        <p
          className="px-5 pb-4 text-xs"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          Le badge se rattache ensuite, depuis la fiche du chauffeur ou depuis la
          page Badges : la carte existe déjà, on enregistre seulement à qui elle
          appartient.
        </p>
      </Card>

      <Card
        title={`${query.data?.total ?? '—'} chauffeur(s)`}
        action={
          <div className="flex gap-2">
            <input
              className="field w-48"
              placeholder="Nom ou matricule"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSkip(0);
              }}
              aria-label="Rechercher"
            />
            <select
              className="field w-auto"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setSkip(0);
              }}
              aria-label="Filtrer par statut"
            >
              <option value="">Tous</option>
              <option value="ACTIVE">Actifs</option>
              <option value="INACTIVE">Désactivés</option>
              <option value="ARCHIVED">Archivés</option>
            </select>
          </div>
        }
      >
        {query.isError && <ErrorState message={(query.error as Error).message} />}
        {query.isLoading && <Skeleton rows={6} />}

        {query.data && query.data.items.length === 0 && (
          <EmptyState>Aucun chauffeur ne correspond à cette recherche.</EmptyState>
        )}

        {query.data && query.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>Matricule</th>
                  <th>Badge</th>
                  <th>Dépôt</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <Link
                        href={`/users/${user.id}`}
                        className="font-medium"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {user.lastName} {user.firstName}
                      </Link>
                    </td>
                    <td className="mono text-xs">{user.employeeNumber ?? '—'}</td>
                    <td className="mono">
                      {user.badge ? (
                        user.badge.maskedBarcode
                      ) : (
                        <span style={{ color: 'var(--color-ink-faint)' }}>
                          aucun badge
                        </span>
                      )}
                    </td>
                    <td>{user.depot?.name ?? '—'}</td>
                    <td>
                      <Badge tone={user.status === 'ACTIVE' ? 'ok' : 'idle'}>
                        {user.status}
                      </Badge>
                    </td>
                  </tr>
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
