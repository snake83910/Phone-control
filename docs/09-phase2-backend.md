# 09 — Phase 2 : backend (livré)

État : **terminé et vérifié**. 103 tests passent, l'API démarre, les migrations
s'appliquent, le parcours complet a été joué de bout en bout avec le badge réel `14557719`.

## 1. Démarrage

```bash
docker compose up -d postgres redis
cp .env.example apps/api/.env      # puis générer les secrets (voir §2)
pnpm install
pnpm --filter @phone-control/api exec prisma migrate deploy
pnpm --filter @phone-control/api exec prisma generate
pnpm db:seed
pnpm dev:api
```

- API : `http://localhost:3001/api/v1`
- Documentation interactive : `http://localhost:3001/api/docs`
- PostgreSQL sur le port **5433**, Redis sur **6380** — décalés volontairement pour ne pas
  entrer en conflit avec une instance déjà présente sur le poste.

Comptes créés par le seed :

| Compte | Rôle | Mot de passe |
|---|---|---|
| `admin@phone-control.local` | `SUPER_ADMIN` | `ChangeMe!2026` |
| `exploitation@transports-demo.local` | `COMPANY_ADMIN` | `ChangeMe!2026` |

Données : entreprise « Transports Démo », dépôt Marseille (retour 18:00, verrouillage 22:00,
`Europe/Paris`, samedi 20:00, dimanche sans règle), téléphones TEL-001/003/008/023,
chauffeurs Rémy Simon (`14557719`), Jean Dupont, Marc Martin, plus une **seconde entreprise**
utilisant volontairement le même numéro de badge, pour que le cloisonnement soit testé
contre un cas réel et non contre une base vide.

## 2. Secrets à générer

```bash
openssl rand -hex 32
```

| Variable | Rôle | Conséquence si perdue |
|---|---|---|
| `BADGE_HMAC_PEPPER` | Poivre du hachage des badges | **Tous les badges deviennent introuvables** |
| `BADGE_ENCRYPTION_KEY` | Chiffrement réversible des badges | L'authentification hors ligne cesse de fonctionner |
| `DEVICE_MASTER_KEY` | Dérivation des clés par appareil | Les listes hors ligne doivent être régénérées |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Jetons administrateurs | Déconnexion générale |
| `DEVICE_JWT_SECRET` | Jetons appareils | Toute la flotte doit se réauthentifier |

En production, l'application **refuse de démarrer** si l'un de ces secrets est resté à sa
valeur d'exemple (`config/configuration.ts`). Un démarrage silencieux avec un poivre par
défaut serait bien pire qu'un crash.

## 3. Ce qui est implémenté

### Base de données
- 20 tables, UUID v7, `timestamptz` en UTC, `company_id` partout.
- `location_events` **partitionnée par mois**, avec fonction de création idempotente et
  partition `DEFAULT` de repli.
- 7 **index uniques partiels** exprimant les règles métier au niveau du SGBD :
  une seule session active par téléphone, une seule par chauffeur, un seul badge actif par
  numéro et par entreprise, une seule affectation active, une seule alerte ouverte par clé
  de déduplication, une seule commande par clé d'idempotence.
- `audit_logs` protégée par trigger : `UPDATE` interdit, `DELETE` réservé à la purge RGPD
  qui doit poser `app.audit_purge = 'on'`.

### Sécurité
- Deux authentifications distinctes : **administrateur** (Argon2id, JWT 15 min, jeton de
  rafraîchissement rotatif avec révocation de famille en cas de réutilisation) et
  **appareil** (JWT 60 min, rafraîchissement rotatif, révocation immédiate).
- RBAC à 4 rôles, appliqué par un guard global : **une route sans décorateur exige un
  administrateur authentifié**.
- Cloisonnement multi-entreprises appliqué par une extension Prisma : `findUnique` est
  réécrit en `findFirst`, `update`/`delete` sont précédés d'une vérification d'appartenance,
  `upsert` est refusé. Une violation se présente au client en **404**, jamais en 403.
- Badges : HMAC-SHA256 avec poivre pour la recherche, AES-256-GCM pour le hors ligne,
  affichage masqué `****7719` partout, valeur complète jamais renvoyée par l'API.
- Limitation de débit Redis dédiée au scan : 10/min par appareil, 5/min par empreinte,
  verrouillage après 30 échecs en une heure — avec alerte.

### Métier
- `POST /v1/auth/barcode` : les 9 contrôles, dans l'ordre, chacun tracé.
- Moteur de règles horaires en **fonctions pures** : jour opérationnel, surcharges
  hebdomadaires / jours fériés / périodes spéciales, fuseaux IANA, changements d'heure.
- Moteur de décision de geofencing, également pur, avec la classification à trois états
  (dedans / dehors / **indéterminé**) qui absorbe les faux positifs GPS.
- Synchronisation idempotente : `event_id` généré par le téléphone, acquittement explicite,
  événements de sécurité traités avant les positions.
- Commandes avec expiration, priorité, idempotence, effets de bord appliqués **à
  l'acquittement** et non à l'émission.
- Alertes déduplicées et clôturées automatiquement au retour à la normale.
- Anonymisation RGPD, rétention configurable par entreprise.

## 4. Tests

```bash
pnpm --filter @phone-control/api test
```

| Suite | Ce qu'elle couvre | Tests |
|---|---|---|
| `src/rules/scenarios.spec.ts` | Scénarios partagés Jest/JUnit : géométrie, règles de dépôt, horaires | 44 |
| `src/crypto/badge-hash.spec.ts` | Normalisation figée, poivre, clés par appareil | 18 |
| `test/barcode-auth.e2e-spec.ts` | Scénarios 1 à 3 + badge révoqué, utilisateur inactif, remplacement de session, cloisonnement, quotas | 14 |
| `test/depot-rules.e2e-spec.ts` | Scénarios 4 à 8 : retour 18h, alerte, verrouillage, rejeu, synchronisation, heartbeat | 13 |
| `test/admin-rbac.e2e-spec.ts` | Connexion, rotation des jetons, RBAC, isolation inter-entreprises, audit immuable | 14 |

Les tests d'intégration s'exécutent sur la **base de développement**, dans des entreprises
créées à la volée. Ils ne vident jamais la base : un test de cloisonnement qui s'exécute sur
une base vide ne prouve rien.

## 5. Ce que les tests ont fait remonter

Deux défauts réels, trouvés par la suite d'intégration et corrigés :

1. **Fuite de cloisonnement à la création.** `POST /v1/users` acceptait un `depotId`
   appartenant à une autre entreprise : la clé étrangère ne contraint que l'existence du
   dépôt, pas son appartenance. Corrigé dans `UsersService.create` et
   `DevicesService.create` par une lecture préalable via le client filtré.

2. **Validation silencieusement inactive sur les filtres de liste.** Les contrôleurs
   déclaraient `@Query() query: PaginationDto & { depotId?: string }`. Un type intersection
   n'étant pas une classe, Nest ne trouvait aucune métadonnée et la `ValidationPipe` était
   ignorée : `take` restait la chaîne `"200"` et la requête Prisma échouait en 500. Corrigé
   par de vraies classes de DTO dans `common/dto/query.dto.ts`.

Un troisième point relève de la conception et non du défaut : **l'authentification hors
ligne impose un stockage réversible du numéro de badge** (docs 05 §3.1 et 07 §3.1). La
Phase 1 le présentait comme optionnel ; il ne l'est pas.

## 6. Écarts connus, à traiter en Phase 3 ou plus tard

| Point | État | Échéance |
|---|---|---|
| Colonnes PostGIS et index GiST | Extension activée, colonnes non créées | Phase 3 (carte) |
| RLS PostgreSQL (seconde barrière) | Non activée ; barrière applicative en place et testée | Phase 3 |
| Worker BullMQ (planificateur 22h, détection hors ligne, purge, partitions) | Non démarré ; les commandes s'émettent aujourd'hui via l'API | Phase 3 |
| MFA TOTP administrateurs | Colonnes présentes, vérification non implémentée | Phase 3 |
| FCM | Non branché ; le téléphone récupère ses commandes par interrogation | Phase 7 |
| WebSocket temps réel | Non implémenté | Phase 3 |
| Endpoint d'export RGPD | Anonymisation faite, export à écrire | Phase 3 |

Aucun de ces points n'est masqué dans le code : ce qui n'est pas implémenté n'est pas
exposé, et ce qui est déclaratif — `device_owner_active` en particulier — est présenté comme
tel plutôt que comme une garantie.

## 7. Note d'exploitation Prisma

Trois objets PostgreSQL ne sont pas exprimables dans `schema.prisma` : le partitionnement,
les index uniques partiels et les triggers. Ils vivent dans une migration maintenue à la
main. **Toute migration générée automatiquement proposera de les supprimer** : relire le SQL
avant application. Procédure détaillée dans `apps/api/prisma/README.md`.
