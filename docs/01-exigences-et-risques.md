# 01 — Exigences consolidées, limitations Android réelles et risques

## 1. Ce que le système doit garantir

| # | Exigence | Niveau de garantie réellement atteignable |
|---|----------|-------------------------------------------|
| E1 | Le téléphone est inutilisable tant qu'aucun badge valide n'a été scanné | **Fort**, à condition d'être Device Owner + Lock Task + application définie comme launcher |
| E2 | Le badge Code 128 existant identifie le chauffeur | **Fort** (ML Kit, CODE_128) |
| E3 | Le serveur est l'autorité d'autorisation quand il est joignable | **Fort** |
| E4 | Le téléphone fonctionne hors ligne de façon dégradée et bornée | **Fort** (cache signé, TTL, révocation à la reconnexion) |
| E5 | Détection entrée/sortie du dépôt sans fausses alertes | **Moyen-fort** — dépend de la qualité GPS ; nécessite un moteur de validation (doc 06) |
| E6 | Verrouillage à 22h même hors ligne | **Fort**, si l'heure système est protégée (`DISALLOW_CONFIG_DATE_TIME` + heure réseau forcée) |
| E7 | L'utilisateur ne peut pas contourner l'application | **Fort mais non absolu** — voir §3 |
| E8 | Isolation multi-entreprises | **Fort** (scoping applicatif + RLS PostgreSQL) |
| E9 | Passage à l'échelle (milliers de téléphones) | **Fort** (partitionnement, file de travaux, push FCM, heartbeats espacés) |

## 2. Limitations Android à connaître AVANT de coder

Ces points ne sont pas négociables : ils sont imposés par la plateforme.

### 2.1 Device Owner

- Le mode **Device Owner ne peut être attribué que sur un appareil neuf ou fraîchement
  réinitialisé, avant l'ajout de tout compte Google**. Il n'existe aucun moyen officiel
  de « promouvoir » un téléphone déjà configuré. → **Factory reset obligatoire** pour chaque
  téléphone entrant dans la flotte.
- Une fois Device Owner attribué, il ne peut être retiré que par `clearDeviceOwnerApp()`
  (appelé par l'application elle-même) ou par un nouveau factory reset. Prévoir une commande
  serveur `DECOMMISSION_DEVICE` pour les sorties de flotte propres.
- `adb shell dpm set-device-owner` **ne fonctionne qu'en atelier**, sur appareil sans compte,
  avec le débogage USB actif. C'est la méthode de développement, pas la méthode de production.
- Le **zero-touch enrollment** (provisioning automatique dès le premier démarrage) exige
  l'achat des terminaux auprès d'un revendeur partenaire Google et un compte zero-touch.
  C'est la méthode idéale à grande échelle, mais son prérequis est commercial, pas technique.

### 2.2 Lock Task Mode (kiosque)

- `startLockTask()` n'est autorisé sans dialogue de confirmation que si le package est
  déclaré via `setLockTaskPackages()` par le Device Owner.
- Depuis Android 9, un Device Owner peut moduler les fonctionnalités disponibles en kiosque :
  `LOCK_TASK_FEATURE_HOME`, `OVERVIEW`, `NOTIFICATIONS`, `GLOBAL_ACTIONS`, `KEYGUARD`,
  `SYSTEM_INFO`. Désactiver `GLOBAL_ACTIONS` masque le menu du bouton Power (donc « Éteindre »).
- Le mode « plusieurs applications autorisées » (Téléphone, Maps, Chrome…) impose que **notre
  application soit le launcher par défaut** (`setPersistentPreferredActivity` sur
  `CATEGORY_HOME`), sinon l'utilisateur revient au launcher constructeur.

### 2.3 Localisation

- Android 10+ : la localisation en arrière-plan (`ACCESS_BACKGROUND_LOCATION`) n'est
  normalement accordable que par un parcours utilisateur en plusieurs étapes.
  **En Device Owner**, `setPermissionGrantState(..., PERMISSION_GRANT_STATE_GRANTED)`
  permet de l'accorder silencieusement. C'est l'une des raisons principales de passer
  par Device Owner plutôt que par une application classique.
- Android 14+ : tout service de localisation en tâche de fond doit être un
  **Foreground Service** déclaré `android:foregroundServiceType="location"` avec la
  permission `FOREGROUND_SERVICE_LOCATION`, et afficher une notification persistante.
  C'est acceptable ici : la notification est visible dans notre kiosque.
- Le Device Owner peut **forcer la localisation activée** (`setLocationEnabled(true)`)
  et en interdire la désactivation (`DISALLOW_CONFIG_LOCATION`). L'exigence « alerte si GPS
  désactivé » devient donc principalement un détecteur d'anomalie, pas un cas nominal.
- **Gestion agressive de la batterie par les constructeurs** (Samsung, Xiaomi, Oppo,
  Huawei) : c'est le risque opérationnel n°1 pour un service de localisation permanent.
  Mitigations : exemption Doze, foreground service, alarme exacte de réveil, plus
  **une campagne de tests par modèle de terminal**. Aucune API ne garantit ce point de
  manière universelle, et il ne faut pas prétendre le contraire.

### 2.4 Horloge

Un utilisateur peut modifier l'heure du téléphone pour échapper à la règle des 22h.
Mitigation : `DISALLOW_CONFIG_DATE_TIME` + `setAutoTimeEnabled(true)` +
`setAutoTimeZoneEnabled(true)` (Device Owner), plus un contrôle de dérive côté application
(`SystemClock.elapsedRealtime()` comparé à l'horloge murale et à l'heure serveur reçue au
dernier échange) → événement de sécurité `CLOCK_TAMPERING` si la dérive est anormale.

### 2.5 Play Services / FCM

- **FCM exige Google Play Services**. Sur un terminal d'entreprise sans services Google,
  les commandes serveur ne peuvent pas être poussées.
  → Architecture retenue : **FCM comme canal rapide, polling adaptatif comme canal de secours
  toujours actif**. Le système reste fonctionnel sans FCM, simplement moins réactif.
- ML Kit : utiliser la variante **bundled** (`com.google.mlkit:barcode-scanning`) et non la
  variante déportée dans Play Services, pour la même raison. Coût : environ 2,5 Mo d'APK.

### 2.6 Scanner Code 128

- Le Code 128 est un code **linéaire** : sa reconnaissance exige un cadrage horizontal
  correct et une résolution suffisante. Contrairement à un QR code, il tolère mal
  l'inclinaison et le flou.
  → Analyse d'image en 1280×720 minimum, autofocus continu, zone d'intérêt (ROI) large et
  peu haute, restriction du détecteur au seul format `FORMAT_CODE_128` (gain de performance
  et réduction des faux positifs).
- Prévoir un **repli de saisie manuelle** du numéro de badge par un responsable authentifié
  (code superviseur), sinon un badge abîmé immobilise un téléphone. **À arbitrer.**

## 3. Ce qui reste impossible (à assumer explicitement)

| Souhait | Réalité | Mitigation |
|---------|---------|------------|
| Empêcher l'extinction du téléphone | Impossible : appui long sur Power = arrêt matériel | Alerte `DEVICE_OFFLINE`, dernière position connue, relance du kiosque au démarrage |
| Empêcher le mode avion / le retrait de la SIM | `DISALLOW_AIRPLANE_MODE` et `DISALLOW_CONFIG_MOBILE_NETWORKS` aident ; le retrait physique de la SIM reste possible | Alerte hors ligne + procédure interne |
| Garantir une position GPS en parking souterrain | Non | Hystérésis, prise en compte de l'`accuracy`, signal Wi-Fi du dépôt comme indice complémentaire |
| Empêcher la copie d'un badge Code 128 | Impossible : c'est un code-barres imprimé, donc photocopiable | Restriction par téléphone autorisé, session unique par utilisateur, alerte de scan concurrent, journal complet |
| Détecter un root de façon infaillible | Non, c'est une course permanente | Détection best-effort + Play Integrity, traitée comme un signal et jamais comme une preuve |

## 4. Risques du projet

### R1 — Conformité RGPD et droit du travail (risque le plus élevé, et il n'est pas technique)

La géolocalisation de salariés est un traitement encadré. En France, la CNIL impose
notamment : information individuelle des salariés, consultation des représentants du
personnel, **interdiction du suivi en dehors du temps de travail**, minimisation des
données, durée de conservation limitée, et une analyse d'impact (AIPD) très probablement
obligatoire.

**Conséquences directes sur l'architecture**, intégrées dès la Phase 1 :

- le suivi de position est **lié à une session active** ; hors session, le téléphone
  verrouillé ne collecte aucune position, sauf commande explicite d'un administrateur,
  elle-même tracée dans l'audit ;
- durée de rétention **configurable par entreprise**, purge automatique par partition ;
- anonymisation et export des données d'une personne exposés en API dès la Phase 2.

Ce point doit être arbitré par le client avant la mise en production. Je le signale, il ne
bloque pas le développement.

### R2 — Provisioning à grande échelle

Factory reset et provisioning manuel représentent environ 10 minutes par téléphone. Pour
des centaines d'unités, il faut soit le zero-touch, soit une chaîne d'atelier documentée et
outillée (doc 04).

### R3 — Faux positifs de geofencing

Une alerte « sortie après retour » injustifiée détruit la confiance dans l'outil. Le moteur
de validation (doc 06) est un livrable de premier plan, testé indépendamment de l'interface
Android.

### R4 — Fiabilité du service en tâche de fond selon les constructeurs

À traiter par une matrice de compatibilité par modèle, réellement testée sur matériel.

### R5 — Faiblesse intrinsèque du badge comme facteur d'authentification

Le Code 128 est un **identifiant**, pas un secret. Le système est donc conçu comme
« identification + autorisation contextuelle », jamais comme « authentification forte ».
Mesures compensatoires en doc 07.

### R6 — Chaîne d'outils Android

La JDK 22 installée localement n'est pas la cible supportée par le plugin Android Gradle.
Le module Android sera configuré pour **JDK 17 (LTS)**, à installer en Phase 4.
