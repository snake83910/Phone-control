# 10 — Phase 3 : dashboard, temps réel et tâches planifiées (livré)

État : **terminé et vérifié**. 113 tests côté API, dashboard construit (19 routes),
parcours complet joué dans un navigateur : connexion, scan de badge, retour au dépôt après
18 h, alerte de sortie, carte, acquittement.

## 1. Démarrage

```bash
docker compose up -d postgres redis
```

```bash
cp .env.example apps/api/.env && cp apps/dashboard/.env.local.example apps/dashboard/.env.local && pnpm install && pnpm --filter @phone-control/api exec prisma migrate deploy && pnpm db:seed
```

Deux processus :

```bash
pnpm dev:api
```

```bash
pnpm dev:dashboard
```

- Dashboard : `http://localhost:3000` — `exploitation@transports-demo.local` / `ChangeMe!2026`
- API : `http://localhost:3001/api/v1` · documentation `http://localhost:3001/api/docs`

## 2. Ce que la Phase 3 ajoute

### Côté serveur

| Ajout | Rôle |
|---|---|
| `GET /v1/dashboard/summary` · `/activity` | Indicateurs de la page d'accueil (§34), calculés par `count` filtrés |
| `GET /v1/locations/live` · `/devices/:id/history` · `/sessions/:id/trail` | Carte et traces. L'historique exige une borne temporelle et la plafonne à 7 jours : la table est partitionnée par mois, une requête sans borne balaierait tout |
| `GET /v1/security/events` · `/scans` | Historique de sécurité et des scans, sans jamais exposer un numéro de badge |
| `GET /v1/audit-logs` | Journal d'audit avec avant/après et identifiant de corrélation |
| `GET/POST/PATCH /v1/companies` | Entreprises et politique de conservation (SUPER_ADMIN) |
| `GET /v1/auth/me` | Profil de l'administrateur, pour que le dashboard n'ait jamais à décoder un jeton |
| Passerelle Socket.IO `/realtime` | Alertes et changements d'état poussés au navigateur |
| Tâches planifiées | Verrouillage à l'heure du dépôt, expiration des sessions, détection hors ligne, entretien et purge |

### Côté dashboard

Toutes les pages de la spécification §33 : `/dashboard`, `/locations`, `/alerts`,
`/sessions`, `/devices` (+ fiche), `/depots` (+ fiche éditable), `/users` (+ fiche),
`/badges`, `/security`, `/audit-logs`, `/settings`.

## 3. Décisions notables

### 3.1 Les jetons ne quittent jamais le serveur Next

Le navigateur n'appelle **jamais** l'API directement : il passe par
`/api/proxy/[...path]`, qui lit le jeton dans un cookie `httpOnly` et l'ajoute à la requête.
Conséquence concrète : une faille XSS sur le dashboard ne permet pas d'exfiltrer une session
administrateur réutilisable ailleurs.

Le proxy gère aussi la rotation : sur un 401, il rafraîchit et rejoue **une** fois. Sans
cela, un administrateur serait déconnecté toutes les quinze minutes — et la tentation serait
d'allonger la durée de vie du jeton, c'est-à-dire d'affaiblir la sécurité par confort.

Seule exception : la poignée de main WebSocket, qui ne peut pas lire un cookie `httpOnly`.
Le jeton est alors remis par `/api/auth/ws-token`, gardé **en mémoire** dans l'onglet, jamais
dans `localStorage`, et sa durée de vie de quinze minutes borne l'exposition.

### 3.2 Tâches planifiées : ni BullMQ, ni paquet séparé

**Écart assumé par rapport à docs/08**, qui prévoyait BullMQ et un paquet `apps/worker` :

- il n'y a **aucun travail soumis par un utilisateur** à mettre en file, seulement des
  balayages périodiques. La file durable existe déjà : c'est `device_commands`, avec ses
  statuts, ses tentatives et ses expirations. BullMQ aurait ajouté une seconde file à
  surveiller pour un besoin déjà couvert ;
- un paquet séparé imposerait de dupliquer Prisma, la configuration et le contexte
  multi-entreprises.

Le module reste **exécutable en processus séparé** (`node dist/worker-main.js`,
`WORKER_ENABLED=false` sur les instances d'API), comme prévu en docs/02 §1. L'exécution
unique entre répliques est garantie par un **verrou Redis**, pas par la topologie du
déploiement. Si Redis est injoignable, la tâche s'exécute quand même : sur un déploiement à
une instance — le cas courant — refuser d'agir serait pire que le risque théorique de double
exécution.

### 3.3 Le graphique d'activité est en petits multiples

Les sessions se comptent en dizaines, les alertes en unités. Les superposer sur une échelle
unique écraserait les alertes ; leur donner un second axe laisserait croire à des croisements
qui n'existent pas. Deux mini-graphiques, chacun avec son échelle, disent la vérité sans
effort d'interprétation. La palette a été validée pour les déficiences de la vision des
couleurs, en clair et en sombre.

### 3.4 Ce que l'interface refuse d'affirmer

- une commande envoyée est annoncée comme **enregistrée**, pas comme exécutée : tant que le
  téléphone n'a pas acquitté, il n'est pas verrouillé ;
- `deviceOwnerActive` faux affiche un bandeau explicite sur la fiche du téléphone : sans ce
  privilège, le kiosque n'est pas garanti ;
- l'état du flux temps réel est affiché en permanence dans la barre latérale : un dashboard
  qui ne reçoit plus rien doit le dire, pas laisser croire au calme ;
- un badge sans valeur chiffrée est marqué « hors ligne : indisponible ».

## 4. Défauts trouvés en exécutant réellement le système

Quatre corrections, toutes issues de l'observation et non de la relecture :

1. **`resolveForDevice(companyId, '', null)`** — appeler la résolution de configuration avec
   un identifiant d'appareil vide produisait un UUID invalide. L'erreur était avalée par la
   boucle de la tâche de surveillance : aucune alerte hors ligne n'était jamais créée, en
   silence. Corrigé par une méthode `resolveForCompany` dédiée.

2. **Appareil « actif » sans porteur** — l'expiration d'une session ne touchait pas l'état de
   l'appareil, qui restait affiché comme actif indéfiniment. Il passe désormais à `LOCKING` :
   le serveur a ordonné le verrouillage, le téléphone ne l'a pas encore confirmé. Ni
   `ACTIVE` (mensonger), ni `LOCKED` (non constaté).

3. **Graphique d'activité vide** — les seaux de jours étaient calculés en heure locale alors
   que `date_trunc` travaille en UTC, et la fenêtre excluait la journée en cours. Le
   graphique affichait donc zéro un jour où il y avait de l'activité.

4. **Tâches planifiées non bornées en test** — les jobs balayaient toute la base, y compris
   le jeu de démonstration, depuis la suite de tests. Ils acceptent désormais une portée
   d'entreprises, ce qui rend les tests hermétiques.

## 5. Limites connues

| Point | État |
|---|---|
| **Fond de carte** | Le style par défaut est celui de démonstration MapLibre : contours de pays seulement, **inexploitable en production**. Un bandeau le signale dans l'interface. `NEXT_PUBLIC_MAP_STYLE_URL` permet de brancher un vrai fournisseur — décision à prendre avec le client, car les coordonnées des salariés transiteraient alors par ce tiers |
| **Rayon du geofence sur la carte** | Dessiné en pixels et non en mètres réels : il situe la zone, il ne la mesure pas |
| **RLS PostgreSQL** | Toujours non activée. La barrière applicative est en place et testée ; la seconde barrière reste à poser |
| **MFA TOTP** | Colonnes présentes, vérification non implémentée |
| **FCM** | Non branché : le téléphone récupère ses commandes par interrogation |
| **Export RGPD** | L'anonymisation existe, l'export de portabilité reste à écrire |
| **Tests du dashboard** | Lint, typecheck et build en CI ; aucun test de bout en bout (Playwright) pour l'instant |

## 6. Prochaine étape

**Phase 4 — application Android.** Elle exige deux prérequis matériels rappelés en
docs/08 §5 : un téléphone Android réinitialisable et la JDK 17. Sans eux, la Phase 5
(Device Owner) ne pourra pas être validée honnêtement.
