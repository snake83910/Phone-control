# 02 — Architecture globale

## 1. Vue d'ensemble

```text
                        ┌───────────────────────────────────────┐
                        │            NAVIGATEUR ADMIN           │
                        └──────────────────┬────────────────────┘
                                           │ HTTPS + WSS
                        ┌──────────────────▼────────────────────┐
                        │      DASHBOARD  (Next.js 15)          │
                        │   SSR + BFF (aucun accès direct BDD)  │
                        └──────────────────┬────────────────────┘
                                           │ REST /api/v1  +  Socket.IO
   ┌───────────────────┐                   │
   │  TÉLÉPHONE ANDROID│───── HTTPS ───────┤
   │  (DPC + kiosque)  │◄──── FCM ─────┐   │
   └───────────────────┘               │   │
                                       │   │
                        ┌──────────────┴───▼────────────────────┐
                        │              API (NestJS)             │
                        │  ┌─────────────────────────────────┐  │
                        │  │ auth · devices · badges · users │  │
                        │  │ depots · geofencing · sessions  │  │
                        │  │ alerts · commands · sync · audit│  │
                        │  └─────────────────────────────────┘  │
                        │  Guards RBAC + TenantContext          │
                        └───┬───────────────┬──────────────┬────┘
                            │               │              │
                  ┌─────────▼──────┐  ┌─────▼──────┐  ┌────▼──────────┐
                  │  PostgreSQL 16 │  │   Redis    │  │  Firebase FCM │
                  │   + PostGIS    │  │  BullMQ    │  │   (optionnel) │
                  └────────────────┘  │  cache     │  └───────────────┘
                                      │  pub/sub   │
                                      └────────────┘
                                            │
                                   ┌────────▼─────────┐
                                   │  WORKER (NestJS) │
                                   │  planificateur   │
                                   │  22h · alertes   │
                                   │  purge RGPD      │
                                   └──────────────────┘
```

**Décision structurante :** l'API et le worker partagent le même code applicatif mais sont
**deux processus distincts**. L'API reste disponible même quand le worker traite des milliers
de verrouillages à 22h, et le worker peut être répliqué indépendamment.

## 2. Séparation des deux authentifications

C'est le point d'architecture le plus important et le plus souvent mal fait.

| | Authentification **appareil** | Session **chauffeur** |
|---|---|---|
| Sujet | Le téléphone en tant que machine | La personne qui utilise le téléphone |
| Établie par | Enrôlement (token à usage unique) | Scan du badge Code 128 |
| Portée | Permanente jusqu'à révocation | Une journée de travail au maximum |
| Support | JWT appareil (courte durée) + refresh token rotatif, clé privée en Keystore | Ligne dans `sessions`, état métier |
| Usage | Autorise les appels d'API `/devices/*`, `/sync/*` | Autorise l'usage physique du téléphone |

Un téléphone reste authentifié auprès du serveur **même verrouillé** : il doit pouvoir
recevoir des commandes, envoyer un heartbeat et se synchroniser sans session chauffeur.
Confondre les deux rendrait le déverrouillage à distance impossible.

## 3. Flux principal — scan de badge

```text
CHAUFFEUR        ANDROID              API                   POSTGRES
    │               │                  │                        │
    │  présente     │                  │                        │
    │  le badge     │                  │                        │
    ├──────────────►│                  │                        │
    │               │ ML Kit CODE_128  │                        │
    │               │ + anti-doublon   │                        │
    │               │ (300 ms debounce)│                        │
    │               │                  │                        │
    │               │ POST /auth/barcode                        │
    │               │ {barcode, deviceId, nonce, scannedAt}     │
    │               ├─────────────────►│                        │
    │               │                  │ hash = HMAC(pepper,    │
    │               │                  │        normalize(bc))  │
    │               │                  ├───────────────────────►│
    │               │                  │  9 contrôles (§4)      │
    │               │                  │◄───────────────────────┤
    │               │                  │ clôture session        │
    │               │                  │ précédente + création  │
    │               │◄─────────────────┤ 200 {user, session,    │
    │               │                  │      config, policy}   │
    │               │ stopLockTask     │                        │
    │               │ → écran ACTIF    │                        │
    │◄──────────────┤                  │                        │
    │               │ démarrage du service de localisation      │
```

**Contrôles serveur, dans cet ordre** (chaque échec produit un événement de sécurité et une
réponse générique côté téléphone, pour ne pas divulguer laquelle des conditions a échoué) :

1. le badge existe (recherche par HMAC) ;
2. le badge est `ACTIVE` et non révoqué ;
3. l'utilisateur rattaché est `ACTIVE` ;
4. le téléphone existe et est enrôlé ;
5. le téléphone est `ACTIVE` et non révoqué ;
6. l'affectation utilisateur ↔ téléphone est valide et non expirée ;
7. `badge.company_id == user.company_id == device.company_id` ;
8. la politique du dépôt autorise l'ouverture de session à cet instant ;
9. les quotas anti-force-brute ne sont pas dépassés (par appareil et par valeur de badge).

## 4. Flux « retour au dépôt » et alerte

```text
   ANDROID (moteur local)                         API / WORKER
        │                                              │
  fix GPS toutes les N s                               │
        │                                              │
  moteur geofence (doc 06)                             │
        │  transition confirmée                        │
        ├─ ENTER_DEPOT ────────── POST /sync/events ──►│
        │                                              │ heure locale du dépôt ≥ return_time ?
        │                                              │   oui → session.state = RETURNED
        │                                              │         returned_at / lat / lon / accuracy
        │◄──── commande implicite dans la réponse ──────┤
        │  état local = RETURNED                       │
        │                                              │
        ├─ EXIT_DEPOT (confirmé) ─ POST /sync/events ──►│
        │                                              │ état == RETURNED ?
        │                                              │   oui → AFTER_RETURN_EXIT
        │                                              │         alerte HIGH + WS + FCM admin
```

**L'évaluation « après l'heure de retour » est faite deux fois** : localement par le
téléphone (pour fonctionner hors ligne) et par le serveur à la réception de l'événement
(autorité). En cas de divergence, **le serveur fait foi** et corrige l'état du téléphone
lors de la synchronisation suivante.

## 5. Flux de verrouillage à 22h

```text
WORKER                                       ANDROID
  │                                             │
  │ tâche répétable par dépôt                   │  AlarmManager setExactAndAllowWhileIdle
  │ (BullMQ, calcul du prochain 22:00           │  planifiée pour lock_time (tz du dépôt)
  │  dans la timezone du dépôt)                 │  + WorkManager de contrôle /15 min
  │                                             │
  ├─ pour chaque device actif :                 │
  │    device_commands: LOCK_DEVICE (SCHEDULED) │
  │    → FCM data message (priorité haute)      │
  │                     ─────────────────────► │  réception
  │                                             │  verrouillage + startLockTask
  │◄──── POST /devices/commands/:id/ack ────────┤  LOCK_EXECUTED
  │                                             │
  │  SI hors ligne : la commande reste en file  │  L'ALARME LOCALE VERROUILLE QUAND MÊME
  │  et sera livrée à la reconnexion            │  (aucune dépendance au réseau)
```

Le verrouillage local est la source de vérité **en dernier recours** ; la commande serveur
est le chemin nominal. Les deux sont idempotents : verrouiller un téléphone déjà verrouillé
n'a aucun effet et ne produit pas d'erreur.

## 6. Machine à états de l'appareil

```text
                 ┌──────────────────────────────────────────────┐
                 │                                              │
                 ▼                                              │
            ┌─────────┐   appui « scanner »   ┌──────────┐      │
            │ LOCKED  ├──────────────────────►│ SCANNING │      │
            └─────────┘                       └────┬─────┘      │
                 ▲                                 │ code lu    │
                 │                                 ▼            │
                 │                        ┌────────────────┐    │
                 │      refus / timeout   │ AUTHENTICATING │    │
                 ├────────────────────────┤ (ou offline)   │    │
                 │                        └────────┬───────┘    │
                 │                                 │ accordé    │
                 │                                 ▼            │
                 │                            ┌────────┐        │
                 │                            │ ACTIVE │        │
                 │                            └───┬────┘        │
                 │                                │ ENTER_DEPOT │
                 │                                │ après       │
                 │                                │ return_time │
                 │                                ▼             │
                 │                          ┌──────────┐        │
                 │                          │ RETURNED ├────────┘
                 │                          └────┬─────┘  EXIT_DEPOT
                 │                               │        → ALERT (état
                 │        lock_time / LOCK_DEVICE│         non bloquant,
                 │        / FORCE_LOGOUT         │         superposé)
                 │                               ▼
                 │                          ┌─────────┐
                 └──────────────────────────┤ LOCKING │
                                            └─────────┘
```

`ALERT` n'est pas un état de la machine principale mais un **indicateur superposé** :
un téléphone en alerte reste `RETURNED` ou `ACTIVE`. Modéliser l'alerte comme un état
bloquant serait une erreur (que faire d'un chauffeur légitimement reparti ?).

**Cette machine est spécifiée une fois et implémentée deux fois** (Kotlin sur le
téléphone, TypeScript sur le serveur). Pour garantir qu'elles ne divergent pas, la Phase 2
produit `packages/state-machine-spec/` : des **scénarios de test au format JSON**, exécutés
à la fois par Jest et par JUnit. C'est le seul moyen fiable de partager une logique métier
entre deux langages.

## 7. Canaux de communication serveur → téléphone

| Canal | Latence | Fiabilité | Usage |
|---|---|---|---|
| FCM (data message, priorité haute) | 1–10 s | Dépend de Play Services et de Doze | Chemin nominal des commandes |
| Polling adaptatif | 30 s (session active) / 5 min (verrouillé) / 15 min (nuit) | Totale | Secours permanent |
| Synchronisation planifiée | 15 min | Totale | Configuration, listes, purges |

Aucune connexion permanente (WebSocket) côté téléphone : c'est trop coûteux en batterie sur
une flotte de milliers d'appareils. Le WebSocket est réservé au dashboard.

## 8. Déploiement cible

```text
                       Internet
                          │  443/tcp
                 ┌────────▼─────────┐
                 │  Reverse proxy   │  Caddy ou Traefik
                 │  TLS + HSTS      │  certificats automatiques
                 └───┬──────────┬───┘
        admin.­*      │          │      api.*
                 ┌───▼───┐  ┌───▼───┐
                 │ dash  │  │  api  │──┐
                 └───────┘  └───┬───┘  │
                                │      │
                       ┌────────▼──┐ ┌─▼──────┐
                       │ postgres  │ │ redis  │
                       │ +postgis  │ │        │
                       └───────────┘ └────┬───┘
                                          │
                                    ┌─────▼─────┐
                                    │  worker   │
                                    └───────────┘
```

- Un seul VPS suffit pour démarrer (jusqu'à environ 2 000 téléphones avec les intervalles
  par défaut). Les composants sont conçus sans état pour être répliqués ensuite.
- PostgreSQL et Redis ne sont **jamais exposés** hors du réseau Docker interne.
- HTTPS obligatoire de bout en bout ; le téléphone refuse toute connexion en clair
  (`cleartextTrafficPermitted="false"`) et applique un certificate pinning.

## 9. Estimation de charge (2 000 téléphones, hypothèses par défaut)

| Flux | Fréquence | Volume / jour |
|---|---|---|
| Points de localisation (session active, 60 s, 8 h) | 480 / appareil | ~960 000 lignes |
| Heartbeats (5 min en session, 30 min verrouillé) | ~140 / appareil | 280 000 requêtes |
| Scans de badge | 1 à 3 / appareil | ~4 000 |
| Commandes | ~1 / appareil | 2 000 |

À un an, `location_events` dépasse 300 millions de lignes : le **partitionnement mensuel et
la purge par `DROP PARTITION`** ne sont pas une optimisation prématurée, mais une nécessité
(doc 03). L'écriture des positions passe par une **insertion par lots** (le téléphone envoie
un paquet toutes les 5 minutes, pas un point à la fois).
