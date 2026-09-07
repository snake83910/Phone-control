# 08 — Arborescence, stack et plan de réalisation

## 1. Arborescence du monorepo

```text
phone-control/
│
├── apps/
│   ├── api/                        # NestJS 11 + Fastify
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/             # guards, filtres, intercepteurs, TenantContext
│   │   │   ├── config/             # configuration typée + validation Zod
│   │   │   ├── prisma/             # service + extension multi-tenant
│   │   │   ├── auth/               # admins (JWT/MFA) + /auth/barcode
│   │   │   ├── companies/
│   │   │   ├── depots/
│   │   │   ├── users/
│   │   │   ├── badges/
│   │   │   ├── devices/            # enrôlement, heartbeat, santé
│   │   │   ├── assignments/
│   │   │   ├── sessions/
│   │   │   ├── geofencing/         # moteur de règles serveur
│   │   │   ├── locations/
│   │   │   ├── alerts/
│   │   │   ├── commands/
│   │   │   ├── sync/               # push/pull appareils
│   │   │   ├── notifications/      # FCM, e-mail, SMS (adaptateurs)
│   │   │   ├── realtime/           # passerelle Socket.IO
│   │   │   ├── audit/
│   │   │   ├── privacy/            # export, anonymisation, rétention
│   │   │   └── health/
│   │   └── test/
│   │
│   ├── worker/                     # processus BullMQ (partage src/ via nest-cli)
│   │   └── src/jobs/               # lock-scheduler, offline-detector, retention, partitions
│   │
│   ├── dashboard/                  # Next.js 15 App Router
│   │   ├── src/app/
│   │   │   ├── (auth)/login/
│   │   │   └── (app)/
│   │   │       ├── dashboard/  companies/  users/  badges/
│   │   │       ├── devices/    depots/     alerts/  locations/
│   │   │       ├── sessions/   security/   audit-logs/  settings/
│   │   ├── src/components/         # ui/, map/, charts/, tables/
│   │   ├── src/lib/                # client API, hooks, WebSocket, permissions
│   │   └── e2e/
│   │
│   └── android/                    # projet Gradle Kotlin autonome
│       ├── app/src/main/java/com/<org>/phonecontrol/
│       │   ├── PhoneControlApp.kt
│       │   ├── di/
│       │   ├── ui/                 # Compose : lock, scanner, active, admin
│       │   ├── scanner/            # CameraX + ML Kit CODE_128
│       │   ├── authentication/
│       │   ├── kiosk/              # DPC, DeviceAdminReceiver, LockTask, restrictions
│       │   ├── location/           # foreground service, fournisseur fusionné
│       │   ├── geofence/           # moteur pur + adaptateurs
│       │   ├── rules/              # machine à états, règles horaires
│       │   ├── sync/               # moteur de synchronisation, WorkManager
│       │   ├── database/           # Room + SQLCipher, DAO
│       │   ├── network/            # Retrofit/OkHttp, épinglage, intercepteurs
│       │   ├── security/           # Keystore, détections, intégrité
│       │   ├── commands/
│       │   └── provisioning/
│       ├── app/src/test/           # JUnit : moteur, règles, machine à états
│       └── app/src/androidTest/
│
├── packages/
│   ├── shared-types/               # types API partagés api ↔ dashboard
│   ├── state-machine-spec/         # scénarios JSON exécutés par Jest ET JUnit
│   └── config/                     # eslint, tsconfig, prettier partagés
│
├── docs/
├── docker/                         # Dockerfiles, init SQL, configuration proxy
├── tools/provisioning/             # génération de QR codes, import CSV atelier
├── .github/workflows/
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env.example
└── README.md
```

Le module Android est un projet Gradle **indépendant** du workspace pnpm : mélanger les deux
chaînes d'outils dans un seul système de build apporte plus de problèmes que de bénéfices.
Le lien entre les deux se fait par `packages/state-machine-spec` (fichiers JSON lus par les
deux côtés) et par la spécification OpenAPI, dont le client Kotlin est généré.

## 2. Stack et versions

| Domaine | Choix | Justification |
|---|---|---|
| Runtime API | Node 22 LTS + NestJS 11 sur Fastify | Fastify pour le débit sur les endpoints de heartbeat |
| ORM | Prisma 6 | Migrations, typage, extensions pour le multi-tenant |
| Base | PostgreSQL 16 + PostGIS | Requêtes spatiales indexées, partitionnement déclaratif |
| File / cache | Redis 7 + BullMQ | Planification 22h, limitation de débit, pub/sub WebSocket |
| Temps réel | Socket.IO avec adaptateur Redis | Réplicable |
| Dashboard | Next.js 15, React 19, TypeScript, Tailwind 4 | |
| Composants | shadcn/ui + Radix | Accessibilité, pas de dette de design |
| Cartographie | **MapLibre GL** + fond OpenStreetMap ou MapTiler | Pas d'enfermement propriétaire, coût maîtrisé |
| Tableaux | TanStack Table + TanStack Query | Volumes importants, pagination serveur |
| Android | Kotlin 2.x, Compose, Hilt, Room, WorkManager, CameraX, ML Kit (bundled), OkHttp/Retrofit | |
| JDK Android | **17 LTS** | Compatibilité AGP (la JDK 22 locale ne convient pas) |
| Tests | Jest + Supertest + Testcontainers · JUnit5 + Turbine + Robolectric · Playwright | |
| CI | GitHub Actions | lint, typecheck, tests, build, image Docker |

## 3. Endpoints prévus (extrait)

```text
POST   /api/v1/auth/login                    admin
POST   /api/v1/auth/refresh
POST   /api/v1/auth/barcode                  appareil — scan de badge
POST   /api/v1/devices/enroll                appareil — jeton d'enrôlement
POST   /api/v1/devices/heartbeat
GET    /api/v1/devices/:id/commands
POST   /api/v1/devices/commands/:id/result
POST   /api/v1/sync/events                   lot d'événements
GET    /api/v1/sync/pull                     configuration + commandes + état
POST   /api/v1/sessions/:id/end
GET    /api/v1/devices        /devices/:id   dashboard
GET    /api/v1/users          /users/:id
GET    /api/v1/badges         POST /badges/:id/revoke
GET    /api/v1/depots         /depots/:id
GET    /api/v1/alerts         POST /alerts/:id/acknowledge
GET    /api/v1/locations/live /locations/history
GET    /api/v1/audit-logs
GET    /api/v1/users/:id/data-export
POST   /api/v1/users/:id/anonymize
```

## 4. Plan des phases

| Phase | Contenu | Livrable vérifiable |
|---|---|---|
| **1** | Analyse et architecture | Ces documents — **à valider** |
| **2** | Backend : Prisma, migrations, RBAC, `/auth/barcode`, sessions, commandes, sync, Swagger, tests | `docker compose up` + suite Jest verte + Swagger complet |
| **3** | Dashboard : authentification, appareils, utilisateurs, badges, dépôts, alertes, carte, temps réel | Parcours administrateur complet sur données de démonstration |
| **4** | Android : projet, écran de verrouillage, scanner CODE_128, Room, réseau, sessions, localisation, geofence, règles horaires, synchronisation | APK fonctionnel **sans** Device Owner (mode dégradé assumé) |
| **5** | Device Owner et kiosque : DPC, provisioning QR, Lock Task, restrictions, outils d'atelier | Téléphone réel provisionné de bout en bout |
| **6** | Hors ligne : cache chiffré, empreintes par appareil, file d'événements, résolution de conflits | Scénario complet en mode avion |
| **7** | Alertes : moteur, déduplication, FCM, WebSocket, e-mail/SMS | Alerte `AFTER_RETURN_EXIT` de bout en bout en moins de 5 s |
| **8** | Tests d'intégration, charge, matrice de terminaux, documentation finale | Les 8 tests de la spécification, automatisés |

**Ordre imposé par les dépendances** : les phases 2 et 3 peuvent se chevaucher partiellement,
les phases 4 à 6 sont séquentielles. La phase 5 exige du **matériel réel** — un téléphone
Android dédié, réinitialisable — sans lequel elle ne peut pas être validée honnêtement.

## 5. Prérequis à réunir avant la Phase 2

| # | Élément | Bloquant pour |
|---|---|---|
| P1 | Un téléphone Android de test, réinitialisable (Android 11+ recommandé) | Phase 5 |
| P2 | Installation de la JDK 17 | Phase 4 |
| P3 | Domaine et certificat TLS (même en préproduction) | Phases 5 et 7 |
| P4 | Projet Firebase pour FCM, ou décision de s'en passer | Phase 7 |
| P5 | Format réel des badges : longueur, jeu de caractères, zéros de tête, préfixes | Phase 2 |
| P6 | Coordonnées et paramètres d'un dépôt réel | Phase 4 |
| P7 | Décision sur le repli de saisie manuelle du badge | Phase 4 |
| P8 | Arbitrage RGPD (information, consultation, AIPD) | Mise en production |

**P5 est le seul prérequis strictement bloquant pour démarrer la Phase 2** : la
normalisation avant hachage doit être figée avant que le premier badge ne soit enregistré,
car la modifier ensuite invaliderait toute la base.
