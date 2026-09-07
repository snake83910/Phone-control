import { Prisma, PrismaClient } from '@prisma/client';
import { TenantContext } from '../common/tenant-context';

/**
 * Cloisonnement multi-entreprises appliqué au niveau de l'ORM.
 *
 * Première barrière du dispositif décrit en docs/03-modele-de-donnees.md §4.
 * L'objectif est qu'un oubli de `where: { companyId }` dans un service ne puisse
 * PAS produire de fuite : le filtre est injecté ici, systématiquement.
 *
 * Les opérations ciblant une ligne unique (findUnique, update, delete) ne
 * peuvent pas recevoir de filtre supplémentaire dans leur `where`. Elles sont
 * donc soit réécrites en findFirst, soit précédées d'une vérification
 * d'appartenance. Deux requêtes valent mieux qu'une fuite.
 */

/** Modèles portant une colonne company_id. */
const TENANT_MODELS = new Set<string>([
  'Admin',
  'Depot',
  'User',
  'Badge',
  'Device',
  'EnrollmentToken',
  'DeviceAssignment',
  'Session',
  'Geofence',
  'LocationEvent',
  'GeofenceEvent',
  'BarcodeScanEvent',
  'SecurityEvent',
  'Alert',
  'DeviceCommand',
  'DeviceSettings',
  'RetentionPolicy',
  'AuditLog',
]);

/** L'entreprise se filtre sur sa propre clé primaire. */
const COMPANY_MODEL = 'Company';

const READ_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const UNIQUE_READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow']);
const BULK_WRITE_OPERATIONS = new Set(['updateMany', 'deleteMany']);
const UNIQUE_WRITE_OPERATIONS = new Set(['update', 'delete']);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

type AnyArgs = Record<string, unknown>;

function tenantFilterField(model: string): string {
  return model === COMPANY_MODEL ? 'id' : 'companyId';
}

function mergeWhere(args: AnyArgs, field: string, companyId: string): AnyArgs {
  const where = (args.where ?? {}) as AnyArgs;
  return { ...args, where: { ...where, [field]: companyId } };
}

export function createTenantExtension(base: PrismaClient) {
  return Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const ctx = TenantContext.get();

          // Hors contexte de requête (amorçage, migrations, tests unitaires du
          // client brut) : aucun filtre. Le contexte système est explicite.
          if (!ctx) return query(args);
          if (ctx.crossTenant) return query(args);

          const isTenantModel = TENANT_MODELS.has(model) || model === COMPANY_MODEL;
          if (!isTenantModel) return query(args);

          const { companyId } = ctx;
          if (!companyId) {
            throw new TenantIsolationError(
              `Accès au modèle ${model} sans entreprise active et sans autorisation ` +
                `inter-entreprises explicite.`,
            );
          }

          const field = tenantFilterField(model);
          const a = (args ?? {}) as AnyArgs;

          if (READ_OPERATIONS.has(operation) || BULK_WRITE_OPERATIONS.has(operation)) {
            return query(mergeWhere(a, field, companyId));
          }

          // findUnique ne tolère pas de champ non unique dans son where :
          // on le réécrit en findFirst, dont la sémantique est équivalente ici
          // puisque le filtre d'origine reste unique.
          if (UNIQUE_READ_OPERATIONS.has(operation)) {
            const target =
              operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
            const delegate = (base as unknown as Record<string, AnyArgs>)[
              lowerFirst(model)
            ] as unknown as Record<string, (x: unknown) => unknown>;
            return delegate[target](mergeWhere(a, field, companyId));
          }

          // update / delete : vérification d'appartenance préalable.
          if (UNIQUE_WRITE_OPERATIONS.has(operation)) {
            const delegate = (base as unknown as Record<string, AnyArgs>)[
              lowerFirst(model)
            ] as unknown as Record<string, (x: unknown) => Promise<unknown>>;
            // Pas de `select` : certains modeles (RetentionPolicy) n'ont pas
            // de colonne `id`, leur cle primaire etant company_id.
            const owned = await delegate.findFirst({
              where: { ...(a.where as AnyArgs), [field]: companyId },
            });
            if (!owned) {
              throw new TenantIsolationError(
                `${model} introuvable dans l'entreprise active.`,
              );
            }
            return query(args);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            // Creer une entreprise depuis un contexte d'entreprise n'a aucun
            // sens : cela releve du SUPER_ADMIN, donc du contexte inter-entreprises.
            if (model === COMPANY_MODEL) {
              throw new TenantIsolationError(
                "La creation d'une entreprise exige un contexte inter-entreprises " +
                  '(SUPER_ADMIN).',
              );
            }
            return query(injectCompanyOnCreate(model, a, field, companyId));
          }

          // upsert et opérations non couvertes : refus explicite plutôt que
          // silence. Le code applicatif doit passer par une opération filtrable.
          if (operation === 'upsert') {
            throw new TenantIsolationError(
              `upsert non autorisé sur ${model} : utiliser findFirst + create/update, ` +
                `afin que le cloisonnement reste vérifiable.`,
            );
          }

          return query(args);
        },
      },
    },
  });
}

function injectCompanyOnCreate(
  model: string,
  args: AnyArgs,
  field: string,
  companyId: string,
): AnyArgs {
  const check = (row: AnyArgs): AnyArgs => {
    const current = row[field];
    if (current !== undefined && current !== companyId) {
      throw new TenantIsolationError(
        `Tentative de création d'un ${model} dans une autre entreprise ` +
          `(${String(current)} au lieu de ${companyId}).`,
      );
    }
    return { ...row, [field]: companyId };
  };

  const data = args.data;
  if (Array.isArray(data)) {
    return { ...args, data: data.map((row) => check(row as AnyArgs)) };
  }
  if (data && typeof data === 'object') {
    // Une création par relation imbriquée (connect) porte déjà l'entreprise.
    return { ...args, data: check(data as AnyArgs) };
  }
  return args;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
