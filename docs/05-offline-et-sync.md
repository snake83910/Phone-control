# 05 — Fonctionnement hors ligne et moteur de synchronisation

## 1. Principe directeur

> Le serveur est l'autorité. Le téléphone est autonome.

Ces deux affirmations ne s'opposent que si l'on confond « décider » et « décider
provisoirement ». Le modèle retenu :

- **serveur joignable** → le serveur décide, le téléphone exécute ;
- **serveur injoignable** → le téléphone applique une décision **bornée dans le temps, sur
  la base de données signées par le serveur**, et cette décision est **revalidée** dès le
  retour du réseau.

Aucune autorisation hors ligne n'est permanente.

## 2. Base locale (Room)

```text
UserEntity            id, companyId, firstName, lastName, status, updatedAt
BadgeEntity           id, userId, badgeHmacDevice, last4, status, validUntil
DeviceEntity          id, assetTag, companyId, depotId, kioskMode, state
DepotEntity           id, name, lat, lon, radius, hysteresis, tz,
                      returnTime, lockTime, scheduleOverrides
GeofenceEntity        id, depotId, lat, lon, radius, hysteresis, minDwellSeconds
SessionEntity         id, userId, startedAt, expiresAt, status, state,
                      returnedAt, openedOffline, syncState
LocationEventEntity   eventId, seq, recordedAt, lat, lon, accuracy, ..., syncState
GeofenceEventEntity   eventId, seq, type, occurredAt, evaluationJson, syncState
SecurityEventEntity   eventId, seq, type, severity, occurredAt, metadata, syncState
BarcodeScanEntity     eventId, seq, result, scannedAt, badgeHmac, syncState
PendingCommandEntity  id, command, payload, receivedAt, status, attempts, error
SettingsEntity        clé/valeur typée + version
SyncStateEntity       lastSyncAt, lastSeq, serverTimeOffsetMs, configVersion
```

- Base **chiffrée** (SQLCipher) avec une clé générée dans le Keystore Android
  (StrongBox si le terminal le propose), non extractible.
- `syncState` ∈ `PENDING`, `SENDING`, `SENT`, `ACKED`. Purge locale après acquittement
  serveur et au-delà d'un âge maximal, pour éviter le remplissage du stockage.
- `seq` : compteur monotone par appareil, garantissant l'ordre de rejeu.

## 3. Authentification hors ligne

### 3.1 Le problème des empreintes de badge

Le serveur stocke `HMAC(pepper_serveur, badge)`. Le téléphone ne peut pas recalculer cette
empreinte : cela exigerait de lui confier le pepper global, et un seul téléphone volé
compromettrait alors la vérification de toute la flotte.

**Solution retenue — empreintes à portée d'appareil.**

À l'enrôlement, le serveur dérive une clé propre à l'appareil :

```text
K_device = HKDF(master_key, salt = device_id, info = "offline-badge-v1")
```

`K_device` est transmise une seule fois, sur canal TLS, et stockée **dans le Keystore**
(clé HMAC non exportable). Lors de chaque synchronisation, le serveur envoie pour chaque
badge autorisé sur cet appareil :

```json
{ "userId": "...", "badgeHmac": "<HMAC(K_device, normalize(barcode))>",
  "firstName": "Jean", "lastName": "Dupont", "validUntil": "2026-09-06T04:00:00Z" }
```

Propriétés obtenues :

- le téléphone vérifie un badge hors ligne **sans jamais connaître les valeurs de badges** ;
- une liste extraite d'un téléphone est **inutilisable ailleurs** (clé différente) ;
- la révocation d'un badge se propage par simple disparition de l'entrée à la synchro
  suivante, et immédiatement via une commande `REFRESH_CONFIGURATION` si le téléphone est
  joignable ;
- la liste porte une `validUntil` : passé ce délai, l'authentification hors ligne échoue,
  même si l'application n'a jamais redémarré.

La liste est limitée aux badges **réellement affectés à cet appareil** via
`device_assignments` — typiquement quelques dizaines d'entrées, pas la flotte entière.
C'est aussi ce qui applique la règle « ce téléphone n'est pas autorisé pour cet utilisateur »
en mode hors ligne.

#### Conséquence découverte à l'implémentation : le mode hors ligne impose un stockage réversible

Pour envoyer `HMAC(K_device, valeur_normalisée)`, le serveur doit connaître la **valeur
normalisée** du badge. Or son propre HMAC n'est pas inversible, et une nouvelle affectation
peut être créée des mois après l'enregistrement du badge, quand la valeur saisie a disparu.

L'authentification hors ligne exige donc que le serveur conserve la valeur **chiffrée**
(`badges.barcode_ciphertext`, AES-256-GCM, clé `BADGE_ENCRYPTION_KEY` distincte du poivre).
Ce n'est pas un oubli de conception mais un compromis inévitable, encadré ainsi :

- clé séparée du poivre de hachage : compromettre l'une ne suffit pas ;
- destinée à un KMS en production, jamais stockée en base ;
- si la clé n'est pas configurée, l'authentification hors ligne est **désactivée** et le
  serveur le dit explicitement dans ses journaux, plutôt que d'envoyer des listes vides
  que le terrain découvrirait un mardi soir ;
- la valeur déchiffrée ne quitte jamais le serveur ;
- l'anonymisation RGPD d'un chauffeur efface ce chiffré.

**Conséquence opérationnelle à retenir** : activer le mode hors ligne *après* la mise en
service impose de **réenregistrer les badges**, puisque leur valeur n'existe plus nulle part.
La décision doit donc être prise avant le premier import.

### 3.2 Politique hors ligne

| Paramètre | Défaut | Effet |
|---|---|---|
| `offline_auth_enabled` | `true` | Autorise l'ouverture de session sans serveur |
| `offline_auth_max_duration_minutes` | `480` (8 h) | Durée maximale d'une session ouverte hors ligne |
| `offline_cache_max_age_minutes` | `1440` (24 h) | Âge maximal de la liste locale ; au-delà, refus |
| `offline_grace_on_expiry` | `false` | Comportement à l'expiration hors ligne : verrouiller |

Séquence hors ligne :

```text
scan → hachage local avec K_device → recherche dans BadgeEntity
   ├─ absent ou révoqué localement → REFUS + BarcodeScanEvent(OFFLINE_DENIED)
   ├─ cache trop ancien           → REFUS + message « connexion requise »
   └─ trouvé et cache valide      → session locale (opened_offline = true)
                                    + BarcodeScanEvent(OFFLINE_GRANTED)
                                    + durée plafonnée à offline_auth_max_duration
```

Au retour du réseau, le serveur revalide la session :

- badge toujours valide → session confirmée, `offline_validated_at` renseigné ;
- badge révoqué ou utilisateur désactivé entre-temps → `REVOKE_SESSION` immédiat,
  verrouillage, alerte `UNAUTHORIZED_USER` de sévérité `HIGH`, avec l'écart de temps exact.

## 4. Moteur de synchronisation

```text
┌────────────────────────────────────────────────────────────────┐
│                        SYNC ENGINE                             │
│                                                                │
│  Déclencheurs : réseau retrouvé · périodique (15 min) ·        │
│                 push FCM · fin de session · seuil d'événements │
│                                                                │
│  1. PUSH   POST /api/v1/sync/events                            │
│            { deviceId, lastSeq, events: [...] }   (≤ 500/lot)  │
│            → 200 { ackedEventIds, serverTime, nextBackoffMs }  │
│                                                                │
│  2. PULL   GET  /api/v1/sync/pull?configVersion=N&since=<seq>  │
│            → { settings?, depot?, geofences?, badges?,         │
│                commands: [...], sessionState, serverTime }     │
│                                                                │
│  3. APPLY  application transactionnelle en base locale         │
│                                                                │
│  4. ACK    POST /api/v1/devices/commands/:id/result            │
└────────────────────────────────────────────────────────────────┘
```

### Règles de robustesse

- **Idempotence** : chaque événement porte un `event_id` (UUID v7 généré par le téléphone).
  Le serveur applique un `INSERT ... ON CONFLICT (event_id) DO NOTHING`. Un lot renvoyé
  après un timeout ne crée aucun doublon.
- **Acquittement explicite** : rien n'est purgé localement avant l'`ack` serveur. Une
  réponse HTTP perdue est sans conséquence.
- **Repli exponentiel avec jitter** : 5 s → 10 s → 30 s → 1 min → 5 min → 15 min (plafond).
  Le jitter évite qu'un millier de téléphones se reconnectent à la même seconde après une
  coupure réseau — cause classique d'effondrement au retour de service.
- **Priorité des événements** : les événements de sécurité et de geofence partent avant les
  positions. Une alerte ne doit jamais attendre derrière 4 000 points GPS.
- **Compression** : corps de requête en gzip au-delà de 4 Ko.
- **Plafond de stockage** : au-delà de `max_local_events` (défaut 50 000), les positions les
  plus anciennes sont supprimées en premier ; les événements de sécurité ne le sont jamais.
- **Horloge** : chaque réponse contient `serverTime`. Le téléphone conserve un
  `serverTimeOffsetMs` et l'utilise pour dater les événements, tout en enregistrant aussi
  l'heure locale brute. Un écart supérieur à 5 minutes produit un `CLOCK_TAMPERING`.

### Résolution des conflits

| Conflit | Règle |
|---|---|
| Configuration modifiée des deux côtés | Le serveur gagne toujours (le téléphone ne modifie jamais sa configuration) |
| Session ouverte hors ligne, révoquée côté serveur | Le serveur gagne : révocation et alerte |
| Deux sessions actives pour un même appareil | Contrainte unique en base ; la plus récente gagne, la précédente passe en `ENDED/NEW_SESSION` |
| Événement daté dans le futur | Accepté, horodaté `received_at`, marqué `clock_suspect` |
| Commande exécutée mais acquittement perdu | Réexécution idempotente, résultat identique |

## 5. Consommation batterie

| Situation | Localisation | Heartbeat | Synchronisation |
|---|---|---|---|
| Session active, en mouvement | 60 s / 50 m | 5 min | 5 min |
| Session active, à l'arrêt >10 min | 300 s | 15 min | 15 min |
| Approche du dépôt (< 1 km) | 20 s | 5 min | 5 min |
| Verrouillé | aucune | 30 min | 30 min |
| Batterie < 15 % | 300 s | 30 min | 30 min |

La localisation est **arrêtée hors session** : c'est à la fois une économie de batterie et
une exigence RGPD (pas de suivi hors temps de travail). Le resserrement à l'approche du
dépôt est ce qui rend la détection d'entrée fiable sans échantillonner en continu toute la
journée.
