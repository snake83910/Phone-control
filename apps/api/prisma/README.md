# Migrations — note de maintenance

Le schéma utilise trois fonctionnalités PostgreSQL que Prisma ne sait pas décrire :

| Objet | Où | Pourquoi Prisma ne suffit pas |
|---|---|---|
| Partitionnement mensuel de `location_events` | `..._init/migration.sql` (`PARTITION BY RANGE`) et `..._postgres_specifics/` | Prisma ne modélise pas les tables partitionnées |
| Index **uniques partiels** (`WHERE ...`) | `..._postgres_specifics/` | Prisma ne modélise pas les index conditionnels |
| Triggers d'immuabilité de `audit_logs` | `..._postgres_specifics/` | Prisma ne modélise pas les triggers |

## Conséquence concrète

`prisma migrate dev` compare `schema.prisma` à l'état obtenu en rejouant les migrations.
Les objets ci-dessus n'existant pas dans `schema.prisma`, **une nouvelle migration générée
automatiquement proposera de les supprimer**.

> **Avant d'appliquer toute migration générée, ouvrir le fichier SQL et supprimer les
> `DROP INDEX` / `DROP TRIGGER` portant sur ces objets.**

La commande à utiliser est donc systématiquement :

```bash
pnpm --filter @phone-control/api exec prisma migrate dev --create-only --name <nom>
```

puis relecture du SQL, puis `prisma migrate dev` pour appliquer.

## Partitions

Les partitions mensuelles sont créées par la fonction
`create_location_events_partition(date)`, idempotente. Le worker (Phase 2, tâche
`partition-maintenance`) l'appelle pour les trois mois à venir. La partition `DEFAULT`
existe pour qu'aucun événement ne soit jamais rejeté ; elle doit rester vide en régime
normal, car attacher une partition impose de la scanner.

La purge RGPD s'effectue par `DROP TABLE location_events_YYYY_MM`, opération instantanée
et sans gonflement de la table.

## Purge du journal d'audit

`audit_logs` refuse tout `UPDATE`, et tout `DELETE` sauf si la transaction a positionné :

```sql
SET LOCAL app.audit_purge = 'on';
```

Seule la tâche de rétention le fait.
