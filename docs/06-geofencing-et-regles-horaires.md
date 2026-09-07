# 06 — Moteur de geofencing et règles horaires

## 1. Pourquoi ne pas utiliser l'API Geofencing d'Android telle quelle

L'API `GeofencingClient` de Play Services est pratique mais inadaptée ici :

- latence de déclenchement de plusieurs minutes (elle privilégie la batterie) ;
- aucune maîtrise du seuil de confiance ni de l'hystérésis ;
- dépendance à Play Services ;
- pas de trace des mesures ayant conduit au déclenchement, donc impossible de justifier une
  alerte contestée.

**Décision** : moteur propriétaire alimenté par le `FusedLocationProviderClient`, testable
hors Android, avec l'API Geofencing en **signal complémentaire optionnel** pour réveiller
l'application quand elle a été suspendue.

## 2. Le problème à résoudre

Un point GPS n'est pas une position : c'est une position **plus une incertitude**. Déclencher
une alerte sur un point brut produit des faux positifs quotidiens.

```text
              rayon dépôt = 250 m
    ┌───────────────────────────────────┐
    │                                   │
    │            ● dépôt                │
    │                       ○───┐       │      ○ = position mesurée (260 m du centre)
    │                       │ ±100 m    │      cercle = incertitude
    │                       └───┘       │
    └───────────────────────────────────┘
```

Ici la position mesurée est « hors zone » de 10 m, avec une incertitude de 100 m. Il est
statistiquement plus probable que le téléphone soit **encore dans le dépôt**. Toute alerte
serait injustifiée.

## 3. Algorithme

### 3.1 Filtrage préalable des mesures

Un fix est **écarté des décisions** (mais toujours enregistré) s'il vérifie l'un de ces cas :

| Test | Seuil par défaut |
|---|---|
| Précision insuffisante | `accuracy > gps_accuracy_threshold_meters` (100 m) |
| Position simulée | `location.isMock` → événement `MOCK_LOCATION` + alerte |
| Saut impossible | vitesse implicite entre deux fixes > 180 km/h |
| Fix périmé | `elapsedRealtimeNanos` antérieur de plus de 2 min |
| Altitude/vitesse aberrantes | rejet |

### 3.2 Classification d'un fix par rapport à une zone

Soient `d` la distance haversine au centre, `a` la précision (rayon à 68 %), `R` le rayon de
la zone et `H` l'hystérésis (défaut 75 m) :

```text
  d + a  <  R           →  DEDANS_CERTAIN
  d - a  >  R + H       →  DEHORS_CERTAIN
  sinon                 →  INDÉTERMINÉ   (n'induit aucune transition)
```

L'hystérésis rend la sortie plus exigeante que l'entrée. Un téléphone posé sur la limite
n'oscille donc pas entre `ENTER` et `EXIT`.

### 3.3 Machine à états du geofence, par zone

```text
      ┌──────────┐   DEDANS_CERTAIN ×1     ┌───────────────┐
      │ OUTSIDE  ├────────────────────────►│ ENTER_PENDING │
      └────┬─────┘                         └───────┬───────┘
           ▲                                       │ N fixes DEDANS sur T s
           │                                       ▼
           │ N fixes DEHORS sur T s          ┌──────────┐
      ┌────┴──────────┐  DEHORS_CERTAIN ×1   │  INSIDE  │
      │ EXIT_PENDING  │◄─────────────────────┤          │
      └───────────────┘                      └──────────┘
             │                                     ▲
             └── un seul fix DEDANS ───────────────┘  (annulation immédiate)
```

Paramètres configurables par dépôt :

| Paramètre | Défaut | Rôle |
|---|---|---|
| `geofence_confirmation_seconds` | 120 s | Durée minimale de cohérence avant transition |
| `geofence_confirmation_samples` | 3 | Nombre de fixes cohérents requis |
| `exit_hysteresis_meters` | 75 m | Marge supplémentaire pour sortir |
| `min_dwell_seconds` | 60 s | Présence minimale avant de considérer un vrai retour |

Une transition confirmée émet un `GeofenceEvent` contenant `confidence` et le tableau
`evaluation` des fixes ayant servi à la décision. **Ce détail est ce qui permettra de
répondre à un chauffeur qui conteste une alerte.**

### 3.4 Signaux complémentaires

- **Wi-Fi du dépôt** : si le BSSID courant figure dans `depot.wifi_hints`, la confiance
  « dedans » est renforcée et la sortie exige une confirmation plus longue. Un téléphone
  connecté au Wi-Fi du dépôt n'est pas dans la rue.
- **Immobilité** (`ActivityRecognition`, `STILL`) : un appareil immobile ne peut pas sortir
  de la zone ; les fixes divergents sont considérés comme du bruit.

Ces signaux ne déclenchent jamais seuls une transition : ils pondèrent la confiance.

## 4. Application des règles horaires

### 4.1 Calcul de référence

Toute décision horaire se calcule ainsi :

```text
maintenant_utc  →  ZonedDateTime dans depot.timezone
                →  résolution des règles du jour (special > holidays > weekdays > dépôt)
                →  return_time et lock_time du jour, ou « aucune règle »
                →  comparaison
```

L'utilisation de `java.time` (Kotlin) et de la base tzdata côté serveur gère nativement
l'heure d'été et l'heure d'hiver. **Aucune arithmétique sur des décalages en heures** : les
« UTC+1 / UTC+2 » écrits en dur sont la source d'erreur classique deux fois par an.

Cas particuliers traités explicitement :

- passage à l'heure d'hiver : 02:30 existe deux fois → première occurrence retenue ;
- passage à l'heure d'été : 02:30 n'existe pas → décalage à la première heure valide ;
- `lock_time` antérieur à `return_time` (ex. verrouillage à 02:00) → le verrouillage
  appartient au **jour opérationnel suivant** ; la notion de « journée » est définie par
  `operational_day_start` (défaut 04:00), pas par minuit.

### 4.2 Table de décision

| Situation | Heure locale du dépôt | Événement | Conséquence |
|---|---|---|---|
| Entrée au dépôt | < `return_time` | `ENTER_DEPOT` | Aucune. Session reste `ACTIVE` |
| Entrée au dépôt | ≥ `return_time` | `ENTER_DEPOT_AFTER_RETURN_TIME` | Session → `RETURNED`, horodatage et position de retour |
| Sortie du dépôt | session `ACTIVE` | `EXIT_DEPOT` | Aucune |
| Sortie du dépôt | session `RETURNED` | `AFTER_RETURN_EXIT` | **Alerte `HIGH`** |
| Nouvelle entrée après alerte | quelconque | `ENTER_DEPOT` | Retour à `RETURNED`, l'alerte reste ouverte |
| `lock_time` atteint | — | `LOCK_SCHEDULED` | Verrouillage local + commande serveur |
| Jamais entré au dépôt | après `not_returned_delay` | — | Alerte `NOT_RETURNED` (politique optionnelle) |

### 4.3 Scénarios de la spécification, vérifiés

| Scénario | Résultat attendu | Traitement |
|---|---|---|
| Entrée à 17:30 | Pas de retour | 17:30 < 18:00 → `ENTER_DEPOT` simple |
| Entrée à 18:15 | `RETURNED` | ≥ 18:00 → session `RETURNED`, `returned_at = 18:15` |
| Entrée 18:15, sortie 18:20 | Alerte | Sortie confirmée depuis l'état `RETURNED` → `AFTER_RETURN_EXIT` |
| Chauffeur jamais revenu | « Non retourné » | Absence d'événement ; travail planifié à `lock_time` qui liste les sessions sans `returned_at` |
| Téléphone hors ligne | Événements conservés | File locale, rejeu daté à l'heure réelle |
| GPS désactivé | Événement + alerte | `LOCATION_DISABLED`, sévérité configurable |
| Batterie vide | Dernière position | `last_location_at` et `last_seen_at` affichés avec leur ancienneté explicite |

Le cas « entrée 18:15 puis sortie 18:20 » mérite une remarque : avec une confirmation de
120 s et 3 échantillons, l'alerte se déclenchera vers 18:22. Le délai est le prix de
l'absence de faux positifs. Il est configurable par dépôt, et la valeur par défaut privilégie
délibérément la fiabilité sur la réactivité.

## 5. Double évaluation et arbitrage

Le moteur tourne **sur le téléphone** (pour fonctionner hors ligne et réagir vite) et
**sur le serveur** (autorité et cohérence). Le serveur ne réévalue pas la géométrie à
partir de zéro : il reçoit les transitions confirmées et vérifie la règle horaire avec sa
propre horloge et la configuration du dépôt à jour.

En cas de divergence — le téléphone a jugé « avant 18h » alors que le dépôt avait été
reconfiguré à 17h30 le matin même — **le serveur corrige** et pousse l'état correct à la
synchronisation suivante. C'est pourquoi `sessions.state` est renvoyé dans chaque réponse
de synchronisation.

## 6. Testabilité

Le moteur est écrit comme une **fonction pure** :

```text
(état_précédent, liste_de_fixes, configuration, horloge) → (nouvel_état, événements)
```

Aucune dépendance à Android, à la base de données ni au réseau. Les scénarios de test sont
décrits dans `packages/state-machine-spec/scenarios/*.json` :

```json
{
  "name": "sortie-apres-retour-avec-gps-bruite",
  "depot": { "radius": 250, "hysteresis": 75, "returnTime": "18:00", "tz": "Europe/Paris" },
  "fixes": [
    { "t": "2026-09-05T18:15:00+02:00", "d": 40,  "acc": 15 },
    { "t": "2026-09-05T18:17:00+02:00", "d": 300, "acc": 200 },
    { "t": "2026-09-05T18:19:00+02:00", "d": 45,  "acc": 12 }
  ],
  "expect": { "events": ["ENTER_DEPOT_AFTER_RETURN_TIME"], "state": "RETURNED" }
}
```

Ce scénario vérifie exactement le cas cité dans la spécification : un point aberrant à 300 m
avec 200 m de précision **ne doit produire aucune alerte**. Les mêmes fichiers alimentent
les tests Jest (serveur) et JUnit (Android), ce qui garantit que les deux implémentations
restent d'accord.
