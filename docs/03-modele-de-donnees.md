# 03 — Modèle de données (PostgreSQL 16 + PostGIS, Prisma)

## 1. Principes

1. **UUID v7** comme clé primaire partout (`uuid_generate_v7()` ou génération applicative).
   L'UUID v7 est ordonné dans le temps : il conserve la localité d'insertion des index B-tree,
   ce que l'UUID v4 détruit. C'est déterminant sur les tables d'événements.
2. **`company_id` sur toutes les tables métier**, y compris quand il serait déductible par
   jointure. C'est de la dénormalisation assumée : elle permet l'index composite
   `(company_id, …)` et les politiques RLS sans jointure.
3. **Horodatages en `timestamptz`**, toujours stockés en UTC. La timezone est une propriété
   du dépôt, appliquée à l'affichage et au calcul des règles, jamais au stockage.
4. **Tables d'événements append-only** : pas d'`UPDATE`, pas de `DELETE` unitaire.
   Elles sont partitionnées et purgées par partition.
5. **Suppression logique** (`deleted_at`) sur les entités de référence ; suppression physique
   réservée à l'exercice du droit à l'effacement, tracée dans l'audit.

## 2. Diagramme relationnel

```text
                         ┌───────────┐
                         │ companies │
                         └─────┬─────┘
        ┌──────────────┬───────┼────────────┬──────────────┐
        │              │       │            │              │
   ┌────▼───┐    ┌─────▼───┐ ┌─▼──────┐ ┌───▼─────┐  ┌─────▼──────┐
   │ depots │    │  users  │ │ admins │ │ devices │  │ retention_ │
   └───┬────┘    └────┬────┘ └────────┘ └────┬────┘  │  policies  │
       │              │                      │       └────────────┘
       │         ┌────▼────┐                 │
       │         │ badges  │                 │
       │         └────┬────┘                 │
       │              │                      │
       │              │  ┌───────────────────┴──────┐
       │              └─►│   device_assignments     │
       │                 └──────────────────────────┘
       │                             │
  ┌────▼──────┐               ┌──────▼────┐
  │ geofences │               │ sessions  │
  └───────────┘               └──────┬────┘
                                     │
   ┌─────────────────┬───────────────┼──────────────┬─────────────────┐
   │                 │               │              │                 │
┌──▼─────────────┐ ┌─▼────────────┐ ┌▼───────────┐ ┌▼──────────┐ ┌────▼──────────┐
│location_events │ │geofence_     │ │security_   │ │  alerts   │ │barcode_scan_  │
│ (partitionnée) │ │  events      │ │  events    │ │           │ │   events      │
└────────────────┘ └──────────────┘ └────────────┘ └───────────┘ └───────────────┘

   ┌──────────────────┐   ┌──────────────────┐   ┌────────────┐
   │ device_commands  │   │ device_settings  │   │ audit_logs │
   └──────────────────┘   └──────────────────┘   └────────────┘
```

## 3. Tables

### companies

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| slug | citext UNIQUE | |
| status | enum `ACTIVE`/`SUSPENDED` | |
| settings | jsonb | valeurs par défaut héritées par les dépôts |
| created_at / updated_at / deleted_at | timestamptz | |

### depots

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | |
| company_id | uuid FK | |
| code | text | unique par entreprise |
| name | text | |
| latitude / longitude | double precision | |
| _(geog)_ | geography(Point,4326) | **reportée en Phase 3** — voir la note ci-dessous |
| radius_meters | int | défaut 250 |
| exit_hysteresis_meters | int | défaut 75 |
| timezone | text | IANA, défaut `Europe/Paris` |
| return_time | time | défaut `18:00` |
| lock_time | time | défaut `22:00` |
| schedule_overrides | jsonb | jours de semaine, jours fériés, horaires spéciaux |
| wifi_hints | jsonb | BSSID/SSID du dépôt, indice de présence complémentaire |
| status | enum | |

`schedule_overrides` prépare l'exigence « week-end et jours fériés » sans changement de
schéma ultérieur. Forme retenue :

```json
{
  "weekdays": { "5": { "lockTime": "22:00" }, "6": { "lockTime": "20:00" }, "7": null },
  "holidays": [{ "date": "2026-12-25", "rules": null }],
  "special":  [{ "from": "2026-07-14", "to": "2026-08-15", "returnTime": "17:00" }]
}
```

`null` signifie « aucune règle ce jour-là ». La résolution des règles suit l'ordre :
`special` > `holidays` > `weekdays` > colonnes du dépôt > valeurs par défaut de l'entreprise.

> **Note d'implémentation (Phase 2).** L'extension PostGIS est activée dès la création
> de la base, mais les colonnes `geography` et les index GiST sont **reportés en Phase 3**,
> quand la carte du dashboard en aura réellement besoin. Raison : Prisma ne modélise pas
> les types PostGIS, et les introduire maintenant imposerait des migrations écrites à la
> main pour un besoin que rien n'exprime encore — l'évaluation géométrique se fait sur le
> téléphone, pas en base. Les colonnes `latitude`/`longitude` restent la source de vérité ;
> l'ajout des colonnes `geography` sera purement additif.

### users (chauffeurs)

| Colonne | Type |
|---|---|
| id | uuid PK |
| company_id | uuid FK |
| depot_id | uuid FK nullable (dépôt de rattachement) |
| employee_number | text (unique par entreprise) |
| first_name / last_name | text |
| phone / email | text nullable |
| status | enum `ACTIVE`/`INACTIVE`/`ARCHIVED` |
| created_at / updated_at / deleted_at | timestamptz |

Les chauffeurs **ne sont pas** des comptes connectables : aucun mot de passe. Les
administrateurs vivent dans une table `admins` distincte.

### admins

`id`, `company_id` (nullable pour `SUPER_ADMIN`), `email` (citext unique), `password_hash`
(**Argon2id**), `role` (`SUPER_ADMIN`/`COMPANY_ADMIN`/`DEPOT_ADMIN`/`VIEWER`),
`depot_scope uuid[]`, `mfa_secret`, `status`, `last_login_at`, `failed_attempts`,
`locked_until`.

### badges

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | |
| company_id | uuid FK | |
| user_id | uuid FK | |
| barcode_hash | bytea | **HMAC-SHA256(pepper_serveur, valeur normalisée)** |
| barcode_last4 | text | affichage `******6789` |
| barcode_ciphertext | bytea nullable | AES-256-GCM, clé distincte, uniquement si la ré-exposition de la valeur est requise |
| barcode_type | enum `CODE_128` | extensible (`CODE_39`, `QR_CODE`, `NFC`…) |
| status | enum `ACTIVE`/`INACTIVE`/`REVOKED`/`LOST` | |
| issued_at / revoked_at / revoked_by / revoke_reason | | |

- **Index unique `(company_id, barcode_hash)` filtré sur `status <> 'REVOKED'`** : un même
  numéro de badge peut être réémis après révocation, mais ne peut jamais être actif deux fois.
- La recherche se fait par égalité sur le HMAC : c'est un accès par index, en O(log n).
- La normalisation avant HMAC (`trim`, suppression des zéros de tête optionnels, casse) est
  **figée et versionnée** (`hash_version`) : la changer invaliderait tous les badges.
  Stratégie de rotation détaillée en doc 07 §3.

### devices

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | |
| company_id / depot_id | uuid FK | |
| asset_tag | text | `TEL-023`, unique par entreprise |
| serial_number / imei | text nullable | |
| manufacturer / model / android_version / app_version | text | |
| enrollment_status | enum `PENDING`/`ENROLLED`/`REVOKED`/`DECOMMISSIONED` | |
| device_owner_active | boolean | **remonté par l'appareil**, pas supposé |
| kiosk_mode | enum `KIOSK`/`RESTRICTED`/`STANDARD` | |
| state | enum `LOCKED`/`ACTIVE`/`RETURNED`/`LOCKING`/`UNKNOWN` | dernier état connu |
| last_seen_at | timestamptz | |
| last_sync_at | timestamptz | |
| battery_level | smallint | |
| is_charging / gps_enabled | boolean | |
| network_type | text | |
| storage_free_mb | int | |
| last_latitude / last_longitude / last_accuracy / last_location_at | | dénormalisé pour la carte |
| fcm_token | text nullable | |
| public_key | bytea | clé publique attestée du Keystore |
| revoked_at / revoked_by | | |

Le champ `device_owner_active` est déclaratif : le dashboard doit afficher clairement
« Device Owner : non confirmé » tant que l'appareil ne l'a pas confirmé, plutôt que de
laisser croire à une protection inexistante.

### device_credentials

`device_id`, `refresh_token_hash`, `family_id`, `issued_at`, `expires_at`, `revoked_at`,
`replaced_by`, `user_agent`, `ip`. Rotation avec détection de réutilisation (doc 07).

### device_assignments

`id`, `company_id`, `user_id`, `device_id`, `valid_from`, `valid_until` (nullable),
`created_by`, `status`. Un index unique partiel garantit une seule affectation active par
couple (utilisateur, appareil). C'est cette table qui répond à « Jean Dupont peut utiliser
TEL-001, TEL-003, TEL-008 ».

### sessions

`id`, `company_id`, `user_id`, `device_id`, `depot_id`, `badge_id`,
`started_at`, `expires_at`, `ended_at`, `end_reason`
(`NEW_SESSION`/`ADMIN_LOGOUT`/`SCHEDULED_LOCK`/`EXPIRED`/`REVOKED`),
`status` (`ACTIVE`/`ENDED`/`REVOKED`/`EXPIRED`),
`state` (`ACTIVE`/`RETURNED`),
`returned_at`, `returned_latitude`, `returned_longitude`, `returned_accuracy`,
`opened_offline` (boolean), `offline_validated_at`.

- **Index unique partiel `(device_id) WHERE status = 'ACTIVE'`** : une seule session active
  par téléphone, garanti par la base et non par le code applicatif.
- `opened_offline` marque les sessions ouvertes sans le serveur : elles sont revalidées
  a posteriori, et une session ouverte hors ligne avec un badge entre-temps révoqué génère
  une alerte de sécurité.

### geofences

`id`, `company_id`, `depot_id`, `name`, `type` (`DEPOT`/`ZONE`/`FORBIDDEN`), `geog`
(`geography` — point + rayon ou polygone), `radius_meters`, `hysteresis_meters`,
`min_dwell_seconds`, `status`. Le modèle accepte des polygones dès maintenant : le moteur
Android ne gère que le cercle en v1, mais le schéma n'aura pas à changer.

### location_events — **partitionnée par mois (RANGE sur `recorded_at`)**

`id`, `event_id` (uuid client, unique), `company_id`, `device_id`, `session_id`, `user_id`,
`recorded_at`, `received_at`, `latitude`, `longitude`, `geog`, `accuracy_meters`,
`altitude`, `speed_mps`, `bearing`, `provider`, `is_mock`, `battery_level`,
`inside_geofence` (boolean nullable), `depot_id`.

- Clé primaire `(recorded_at, id)` (contrainte des tables partitionnées).
- Index : `(company_id, device_id, recorded_at DESC)`, GiST sur `geog`.
- Partitions créées à l'avance par le worker (`pg_partman` ou tâche interne).
- Purge RGPD = `DROP TABLE location_events_2026_03` : instantané, sans gonflement.

### geofence_events

`id`, `event_id`, `company_id`, `device_id`, `user_id`, `session_id`, `depot_id`,
`geofence_id`, `event_type` (`ENTER_DEPOT`/`EXIT_DEPOT`/`ENTER_DEPOT_AFTER_RETURN_TIME`/
`AFTER_RETURN_EXIT`), `occurred_at`, `latitude`, `longitude`, `accuracy_meters`,
`confidence` (0–1), `evaluation` (jsonb : les fixes ayant conduit à la décision),
`created_alert_id`.

Le champ `evaluation` est essentiel au support : quand un client conteste une alerte, on
doit pouvoir montrer exactement les mesures qui l'ont déclenchée.

### barcode_scan_events

`id`, `event_id`, `company_id`, `device_id`, `badge_id` (nullable si inconnu),
`user_id` (nullable), `barcode_hash` (pour les inconnus, sans stocker la valeur),
`barcode_last4`, `result` (`SUCCESS`/`UNKNOWN_BADGE`/`BADGE_REVOKED`/`USER_INACTIVE`/
`DEVICE_NOT_AUTHORIZED`/`COMPANY_MISMATCH`/`RATE_LIMITED`/`OFFLINE_GRANTED`/`OFFLINE_DENIED`),
`scanned_at`, `latitude`, `longitude`, `offline` (boolean).

### security_events

`id`, `event_id`, `company_id`, `device_id`, `user_id`, `session_id`, `type`, `severity`,
`occurred_at`, `metadata` (jsonb), `synced_at`.
Types : `LOGIN_SUCCESS`, `LOGIN_FAILED`, `UNKNOWN_BADGE`, `UNAUTHORIZED_USER`,
`ENTER_DEPOT`, `EXIT_DEPOT`, `AFTER_RETURN_EXIT`, `LOCK_DEVICE`, `UNLOCK_DEVICE`,
`DEVICE_OFFLINE`, `LOCATION_DISABLED`, `COMMAND_FAILED`, `ROOT_DETECTED`,
`DEBUGGER_ATTACHED`, `ADB_ENABLED`, `CLOCK_TAMPERING`, `MOCK_LOCATION`,
`KIOSK_EXIT_ATTEMPT`, `DEVICE_OWNER_LOST`, `APP_INTEGRITY_FAILED`.

### alerts

`id`, `company_id`, `device_id`, `user_id`, `depot_id`, `session_id`, `type`, `severity`
(`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`), `title`, `message`, `latitude`, `longitude`,
`context` (jsonb), `dedupe_key`, `created_at`, `acknowledged_at`, `acknowledged_by`,
`resolved_at`, `resolved_by`, `resolution_note`, `status`
(`OPEN`/`ACKNOWLEDGED`/`RESOLVED`/`AUTO_CLOSED`).

Types : `AFTER_RETURN_EXIT`, `UNKNOWN_BADGE`, `UNAUTHORIZED_USER`, `DEVICE_OFFLINE`,
`LOCATION_DISABLED`, `SECURITY_EVENT`, `DEVICE_TAMPERING`, `BATTERY_LOW`,
`NOT_RETURNED`, `LOCK_FAILED`.

**`dedupe_key` avec index unique partiel sur `status = 'OPEN'`** : un téléphone hors ligne
depuis 3 heures produit une alerte, pas cent quatre-vingts. C'est ce qui fait la différence
entre un système d'alertes utilisable et un système que tout le monde ignore.

### device_commands

`id`, `company_id`, `device_id`, `command`, `payload` (jsonb), `status`
(`PENDING`/`SENT`/`DELIVERED`/`EXECUTED`/`FAILED`/`EXPIRED`/`CANCELLED`),
`priority`, `created_at`, `created_by`, `sent_at`, `delivered_at`, `executed_at`,
`expires_at`, `attempts`, `error`, `idempotency_key`.
Commandes : `LOCK_DEVICE`, `UNLOCK_DEVICE`, `FORCE_LOGOUT`, `SYNC_SETTINGS`,
`REVOKE_SESSION`, `REFRESH_CONFIGURATION`, `REBOOT`, `WIPE_DEVICE`, `LOCATE_NOW`,
`COLLECT_DIAGNOSTICS`, `DECOMMISSION_DEVICE`.

Index : `(device_id, status, priority DESC, created_at)` pour la file de récupération.
Toute commande possède une `expires_at` : verrouiller un téléphone avec un ordre vieux de
trois jours n'a aucun sens.

### device_settings

Configuration effective d'un appareil, résolue en cascade **entreprise → dépôt → appareil** :
`location_interval_active_seconds`, `location_interval_idle_seconds`,
`location_min_distance_meters`, `heartbeat_interval_seconds`, `sync_interval_seconds`,
`offline_auth_enabled`, `offline_auth_max_duration_minutes`, `session_max_duration_minutes`,
`battery_alert_threshold`, `offline_alert_delay_minutes`, `allowed_apps` (jsonb),
`kiosk_features` (jsonb), `gps_accuracy_threshold_meters`,
`geofence_confirmation_seconds`, `geofence_confirmation_samples`,
`version` (entier incrémenté à chaque changement), `updated_at`.

Le champ `version` permet au téléphone de savoir en un octet s'il doit re-télécharger sa
configuration. Aucune valeur (18:00, 22:00, 250 m) n'est écrite en dur dans le code.

### retention_policies

`company_id`, `location_events_days` (défaut **60**, plafond CNIL en base active
pour la géolocalisation de salariés ; maximum accepté 365, qui relève de
l'archivage intermédiaire et suppose une justification), `geofence_events_days`
(défaut 365),
`security_events_days` (défaut 365), `sessions_days` (défaut 1095),
`audit_logs_days` (défaut 1825), `anonymize_after_days`.

#### Deux limites à connaître sur la rétention des positions

**La suppression de partition est globale.** Elle emporte les lignes de toutes
les entreprises à la fois, et ne peut donc couper qu'au-delà de la durée la plus
longue du parc. Avec un seul client cela suffit ; à cent cinquante, une
entreprise qui demanderait un an imposerait un an à toutes les autres. Le
`MaintenanceJob` rattrape par des suppressions de lignes, par lots, et
**uniquement pour les entreprises plus strictes que ce maximum** — quand tout le
monde a la même valeur, le cas normal, cette passe ne supprime rien.

Ces suppressions passent par la clé primaire `(recorded_at, id)`. Jamais par
`ctid` : sur une table partitionnée il n'est unique qu'à l'intérieur d'une
partition, et deux lignes de mois différents — donc potentiellement de clients
différents — peuvent porter le même.

**Le découpage mensuel dépasse la durée demandée.** Une partition n'est
supprimable que lorsque son mois entier est hors rétention : avec 60 jours de
rétention, une position peut vivre jusqu'à environ 89 jours. C'est au-delà des
deux mois de la CNIL. Le remède est un découpage hebdomadaire, qui ramènerait le
dépassement à six jours ; il n'est pas fait, et c'est une décision à prendre
avant d'avoir des clients sous contrat.

### audit_logs

`id`, `company_id`, `admin_id`, `action`, `resource_type`, `resource_id`, `before` (jsonb),
`after` (jsonb), `ip`, `user_agent`, `correlation_id`, `created_at`.
Table **append-only** : `REVOKE UPDATE, DELETE` pour le rôle applicatif, au niveau de
PostgreSQL. Un journal d'audit modifiable par l'application ne vaut rien.

## 4. Isolation multi-entreprises

Deux barrières indépendantes :

1. **Applicative (obligatoire)** — une extension Prisma injecte automatiquement
   `where: { companyId }` depuis le `TenantContext` (AsyncLocalStorage alimenté par le
   guard d'authentification) sur tous les modèles portant `company_id`. Les requêtes
   inter-entreprises exigent un rôle `SUPER_ADMIN` et un appel explicitement marqué.
2. **Base de données (défense en profondeur)** — `ROW LEVEL SECURITY` activée avec une
   politique `company_id = current_setting('app.company_id')::uuid`, la variable étant
   positionnée par `SET LOCAL` en début de transaction.

Une suite de tests dédiée tentera systématiquement l'accès croisé entre deux entreprises
sur **chaque** endpoint. C'est le seul moyen de garantir l'exigence de la section 45.

## 5. Rétention et RGPD

| Donnée | Défaut | Mécanisme |
|---|---|---|
| Positions GPS | 90 jours | `DROP PARTITION` mensuel |
| Événements de geofence | 365 jours | suppression par lots |
| Événements de sécurité | 365 jours | suppression par lots |
| Sessions | 3 ans | anonymisation puis suppression |
| Journaux d'audit | 5 ans | jamais supprimés avant échéance |

Endpoints prévus dès la Phase 2 : `GET /users/:id/data-export` (portabilité),
`POST /users/:id/anonymize` (effacement avec conservation des agrégats), les deux tracés
dans l'audit et réservés au `COMPANY_ADMIN`.
