# Phone Control — Gestion et verrouillage de téléphones Android par badge Code 128

Système autonome de gestion de flotte de téléphones Android professionnels :
identification des chauffeurs par leur badge existant (code-barres **Code 128**),
verrouillage kiosque (Device Owner / Android Enterprise), géolocalisation et
geofencing de dépôt, règles horaires configurables, alertes et fonctionnement
hors ligne.

> **État : toutes les phases réalisables sans matériel sont terminées.** 196 tests côté
> serveur, 66 tests Kotlin, **11 tests instrumentés sur Android**, 78 tests d'outillage.
> Les **huit tests de recette** de la spécification passent
> (`pnpm --filter @phone-control/api test:recette`) et le banc de charge tient
> 21 000 événements par seconde — voir
> [docs/15](docs/15-phase8-recette-et-charge.md).
>
> **Il ne reste que ce qui exige des téléphones** : la Phase 5 (Device Owner et kiosque) et
> la matrice de terminaux. Rien n'a jamais été installé sur un téléphone réel — les tests
> instrumentés tournent sur émulateur, ce qui ne dit rien du Device Owner, de la caméra ni
> du GPS.

## Démarrage rapide

```bash
docker compose up -d postgres redis
```

```bash
cp .env.example apps/api/.env && cp apps/dashboard/.env.local.example apps/dashboard/.env.local && pnpm install && pnpm --filter @phone-control/api exec prisma migrate deploy && pnpm db:seed
```

Puis, dans deux terminaux :

```bash
pnpm dev:api
```

```bash
pnpm dev:dashboard
```

- Dashboard : `http://localhost:3000` — `exploitation@transports-demo.local` / `ChangeMe!2026`
- API : `http://localhost:3001/api/v1` — documentation : `http://localhost:3001/api/docs`
- Badge de test : `14557719` → Rémy Simon, autorisé sur TEL-023 et TEL-001

Détail complet (secrets à générer, jeu de données, limites connues) :
[docs/09-phase2-backend.md](docs/09-phase2-backend.md) et
[docs/10-phase3-dashboard.md](docs/10-phase3-dashboard.md).

## Documentation

### Architecture (Phase 1)

| # | Document | Contenu |
|---|----------|---------|
| 00 | [docs/00-synthese.md](docs/00-synthese.md) | Décisions techniques, risques majeurs, questions ouvertes |
| 01 | [docs/01-exigences-et-risques.md](docs/01-exigences-et-risques.md) | Exigences consolidées, limitations Android réelles, risques |
| 02 | [docs/02-architecture-globale.md](docs/02-architecture-globale.md) | Composants, flux, séquences, déploiement |
| 03 | [docs/03-modele-de-donnees.md](docs/03-modele-de-donnees.md) | Schéma PostgreSQL, index, partitionnement, rétention |
| 04 | [docs/04-device-owner-kiosque.md](docs/04-device-owner-kiosque.md) | Stratégie Device Owner, provisioning, Lock Task, restrictions |
| 05 | [docs/05-offline-et-sync.md](docs/05-offline-et-sync.md) | Room, auth hors ligne, moteur de synchronisation, idempotence |
| 06 | [docs/06-geofencing-et-regles-horaires.md](docs/06-geofencing-et-regles-horaires.md) | Moteur anti-faux-positifs, machine à états, fuseaux horaires |
| 07 | [docs/07-securite.md](docs/07-securite.md) | Modèle de menaces, protection des badges, RGPD |
| 08 | [docs/08-arborescence-et-plan.md](docs/08-arborescence-et-plan.md) | Monorepo, stack, plan des phases 2 à 8 |

### Réalisation

| # | Document | Contenu |
|---|----------|---------|
| 09 | [docs/09-phase2-backend.md](docs/09-phase2-backend.md) | Backend livré : démarrage, secrets, tests, écarts connus |
| 10 | [docs/10-phase3-dashboard.md](docs/10-phase3-dashboard.md) | Dashboard, temps réel et tâches planifiées : décisions, défauts trouvés, limites |
| 11 | [docs/11-phase4-android.md](docs/11-phase4-android.md) | Application Android : architecture, parité avec le serveur, ce qui reste à vérifier sur matériel |
| 12 | [docs/12-outillage-provisioning.md](docs/12-outillage-provisioning.md) | Outillage d'atelier : QR codes Device Owner, planches à imprimer, ce qui reste à constater |
| 13 | [docs/13-phase6-hors-ligne-durcissement.md](docs/13-phase6-hors-ligne-durcissement.md) | Base locale chiffrée, intégrité du terminal, compression, horodatage suspect |
| 14 | [docs/14-phase7-alertes-et-reseau.md](docs/14-phase7-alertes-et-reseau.md) | Notification des alertes, épinglage de certificat, réveil des téléphones |
| 15 | [docs/15-phase8-recette-et-charge.md](docs/15-phase8-recette-et-charge.md) | Les huit tests de recette, le banc de charge, et ce qui reste bloqué sur du matériel |
| 16 | [docs/16-applications-et-prise-en-main-a-distance.md](docs/16-applications-et-prise-en-main-a-distance.md) | Blocage d'applications de bout en bout, et ce que « prendre la main à distance » coûte réellement sur Samsung |
| 17 | [docs/17-vision-d-ecran-avec-accord.md](docs/17-vision-d-ecran-avec-accord.md) | Partage d'écran avec accord du chauffeur : les quatre garanties, et le conflit `FLAG_SECURE` qu'il a fallu arbitrer |
| 18 | [docs/18-installation-d-applications-et-play-store.md](docs/18-installation-d-applications-et-play-store.md) | Installation d'APK, Play Store géré, et **l'allowlist DPC de Google qui conditionne la Phase 5** |
| 19 | [docs/19-deploiement-d-applications.md](docs/19-deploiement-d-applications.md) | Déploiement d'APK signés : les trois verrous, et ce qu'ils ne protègent pas |
| 20 | [docs/20-deploiement-vps.md](docs/20-deploiement-vps.md) | Mise en production sur un VPS : images, TLS, sauvegardes, et les défauts que le déploiement a révélés |
| 21 | [docs/21-dossier-allowlist-google.md](docs/21-dossier-allowlist-google.md) | Dossier d'inscription du DPC auprès de Google — préalable à la Phase 5 |
| — | [apps/api/prisma/README.md](apps/api/prisma/README.md) | Migrations : objets PostgreSQL maintenus à la main |
| — | [packages/state-machine-spec/README.md](packages/state-machine-spec/README.md) | Scénarios de référence partagés Jest / JUnit |

## Arborescence

```text
phone-control/
├── apps/
│   ├── api/                 # NestJS + Fastify + Prisma  (Phase 2 — livré)
│   │   └── src/worker/      # Tâches planifiées 22h, purge, surveillance
│   ├── dashboard/           # Next.js 15 + React 19      (Phase 3 — livré)
│   └── android/             # Kotlin + Compose           (Phase 4 — livré)
│       ├── core-rules/      # Moteur de règles PUR, sans Android
│       └── app/             # Scanner, Room, sync, géoloc, kiosque (Phase 5)
├── packages/
│   ├── state-machine-spec/  # Scénarios JSON exécutés par Jest ET JUnit
│   └── provisioning-payload/ # Format du QR code de provisioning, partagé
├── tools/
│   └── provisioning/        # Outillage d'atelier : jetons, QR codes, planches PDF
├── docs/
├── docker/
├── docker-compose.yml
└── .env.example
```

## Stack

- **Backend** : Node 22 · NestJS 11 (Fastify) · TypeScript · Prisma 6 · PostgreSQL 16 + PostGIS · Redis 7 · Swagger
- **Dashboard** : Next.js 15 · React 19 · Tailwind · MapLibre GL · Socket.IO
- **Android** : Kotlin · Compose · CameraX + ML Kit (bundled) · Room · WorkManager · DevicePolicyManager
- **Infra** : Docker Compose · reverse proxy TLS · GitHub Actions

## Commandes

| Commande | Effet |
|---|---|
| `pnpm dev:infra` | Démarre PostgreSQL et Redis |
| `pnpm dev:api` | API en mode watch (tâches planifiées comprises) |
| `pnpm dev:dashboard` | Dashboard en mode développement |
| `pnpm db:migrate` | Applique les migrations (voir la note Prisma avant d'en générer une) |
| `pnpm db:seed` | Jeu de données de démonstration |
| `pnpm test` | Suite complète (nécessite PostgreSQL et Redis démarrés) |
| `pnpm --filter @phone-control/api test:recette` | Les **huit tests de recette** de la spécification, seuls |
| `pnpm --filter @phone-control/api charge` | Banc de charge : heartbeat, synchronisation, scan de badge |
| `pnpm lint` / `pnpm typecheck` | Qualité |

### Android

Depuis `apps/android`, avec `JAVA_HOME` pointant sur une **JDK 17** :

| Commande | Effet |
|---|---|
| `./gradlew :core-rules:test` | Moteur de règles — mêmes scénarios que la suite Jest du serveur, sans émulateur |
| `./gradlew :app:testDebugUnitTest` | Tests Room et file de synchronisation (Robolectric) |
| `./gradlew :app:assembleDebug` | APK de debug |
| `./gradlew :app:connectedDebugAndroidTest` | Tests **instrumentés** : chiffrement de la base, empreinte par clé du Keystore. Exigent un appareil ou un émulateur connecté. |

### Mise en service des téléphones

Pour un téléphone ou une petite série, le dashboard suffit : **Flotte → Mise en service**.
Elle exige `PROVISIONING_SERVER_URL` et l'empreinte de signature de l'APK — voir
`apps/dashboard/.env.local.example`.

Pour un parc entier, depuis `tools/provisioning`, après
`pnpm --filter @phone-control/provisioning build` :

| Commande | Effet |
|---|---|
| `node dist/cli.js checksum --apk <apk>` | Empreinte de signature à mettre dans le QR code |
| `node dist/cli.js batch --config <cfg> --csv <parc.csv> --dry-run` | Plan de campagne, sans rien créer |
| `node dist/cli.js batch --config <cfg> --csv <parc.csv>` | Fiches, jetons, QR codes, planche PDF, manifeste |

Mode d'emploi : [tools/provisioning/README.md](tools/provisioning/README.md).
Ce que produit cet outil contient des **jetons d'enrôlement** : des secrets à durée
limitée, exclus de Git et à détruire après la mise en service.

## Indépendance

Ce projet est **totalement autonome** : aucune dépendance, aucun couplage et
aucune référence à un quelconque système tiers existant.
