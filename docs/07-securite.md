# 07 — Architecture de sécurité

## 1. Modèle de menaces

| Menace | Acteur | Impact | Mitigation principale |
|---|---|---|---|
| M1 — Copie d'un badge Code 128 | Chauffeur, tiers | Usage d'un téléphone au nom d'un autre | Restriction par appareil autorisé, session unique, alerte de scan concurrent, journal |
| M2 — Énumération de numéros de badge | Attaquant avec un téléphone volé | Découverte de badges valides | Limitation de débit par appareil et par valeur, verrouillage progressif, alerte `UNKNOWN_BADGE` |
| M3 — Vol d'un téléphone enrôlé | Tiers | Accès aux données locales et à l'API | Base chiffrée, clés en Keystore non exportables, révocation à distance, jetons courts |
| M4 — Extraction de la liste de badges hors ligne | Tiers avec accès root | Compromission de la flotte | Empreintes HMAC **à portée d'appareil** : la liste est inutilisable ailleurs |
| M5 — Manipulation de l'horloge | Chauffeur | Échapper au verrouillage de 22h | `DISALLOW_CONFIG_DATE_TIME`, heure réseau forcée, détection de dérive |
| M6 — Position simulée | Chauffeur | Fausser le geofencing | `isMock`, `DISALLOW_DEBUGGING_FEATURES`, cohérence vitesse, événement `MOCK_LOCATION` |
| M7 — Sortie du kiosque | Chauffeur | Usage libre du téléphone | Lock Task, restrictions, surveillance et relance, `KIOSK_EXIT_ATTEMPT` |
| M8 — Interception réseau | Réseau hostile | Vol de jetons | TLS 1.2+ obligatoire, épinglage de certificat, aucun trafic en clair |
| M9 — Accès inter-entreprises | Administrateur malveillant | Fuite de données | Scoping applicatif + RLS PostgreSQL + tests d'isolation |
| M10 — Compromission d'un compte administrateur | Externe | Contrôle de la flotte | Argon2id, MFA, jetons courts avec rotation, audit intégral, alerte sur action sensible |
| M11 — Falsification des journaux | Interne | Effacement de traces | `audit_logs` en `INSERT` seul au niveau PostgreSQL |
| M12 — Déni de service sur `/auth/barcode` | Externe | Indisponibilité | Limitation de débit distribuée (Redis), coût de hachage constant, réponses uniformes |

## 2. Chaîne d'authentification

### 2.1 Administrateurs

- Mot de passe haché en **Argon2id** (`m=64 Mio, t=3, p=4`) — préféré à bcrypt pour sa
  résistance aux attaques matérielles.
- **Jeton d'accès JWT** de 15 minutes (RS256, clé en fichier monté, jamais dans l'image) ;
  **jeton de rafraîchissement** opaque de 7 jours, stocké haché, à **rotation avec détection
  de réutilisation** : si un jeton déjà consommé réapparaît, toute la famille est révoquée
  et une alerte de sécurité est émise. C'est le comportement correct face au vol de jeton.
- MFA TOTP obligatoire pour `SUPER_ADMIN` et `COMPANY_ADMIN`.
- Verrouillage progressif : 5 échecs → 15 minutes, puis paliers croissants, par compte et
  par adresse IP.

### 2.2 Appareils

- L'enrôlement consomme un **jeton à usage unique** (TTL 7 jours) créé par le dashboard.
- L'appareil génère une **paire de clés dans le Keystore** (attestation matérielle vérifiée
  côté serveur quand elle est disponible) et transmet la clé publique. Elle sert à signer les
  demandes de rafraîchissement : un jeton volé sans la clé privée est inexploitable.
- Jeton d'accès de 60 minutes, rafraîchissement rotatif de 30 jours.
- Révocation immédiate depuis le dashboard : le prochain appel échoue en 401, l'application
  se verrouille et efface son cache hors ligne.

### 2.3 Chauffeurs

Le badge **n'est pas un facteur d'authentification** : c'est un identifiant. La sécurité
provient du faisceau de contraintes — appareil autorisé, entreprise, affectation valide,
plage horaire, session unique — et non du secret du numéro.

Cette position doit être écrite noir sur blanc dans la documentation client : elle évite de
promettre un niveau de sécurité que le support physique ne permet pas.

## 3. Protection de la valeur des badges

### 3.1 Stockage serveur

```text
valeur scannée  "  0123456789 "
      │ normalisation versionnée v1 : trim, majuscules, suppression des caractères non
      │ alphanumériques, conservation des zéros de tête
      ▼
   "0123456789"
      │ HMAC-SHA256(pepper_serveur)          pepper : variable d'environnement / KMS,
      ▼                                       jamais en base, jamais dans Git
   badges.barcode_hash  (bytea, index unique (company_id, barcode_hash))
   badges.barcode_last4 = "6789"             pour l'affichage ******6789
   badges.hash_version  = 1
```

**Pourquoi un HMAC et non bcrypt/Argon2** : la recherche doit être un accès par index sur
des millions de lignes, à chaque scan. Un hachage lent est ici inutilisable, et inutile :
le badge n'est pas un mot de passe choisi par un humain. Le HMAC avec pepper protège contre
la reconstruction du numéro par dictionnaire en cas de fuite de la base, ce qui est
l'objectif réel.

**Chiffrement réversible — requis dès que le mode hors ligne est activé.** Ce point a été
révisé à l'implémentation : le serveur doit pouvoir recalculer, pour chaque appareil, une
empreinte à partir de la valeur normalisée du badge (doc 05 §3.1). Le HMAC n'étant pas
inversible, `barcode_ciphertext` (AES-256-GCM, clé `BADGE_ENCRYPTION_KEY` **distincte du
poivre**) devient indispensable. Sans cette clé, le système fonctionne, mais uniquement en
ligne — et il le signale. Activer le hors ligne après coup impose de réenregistrer les
badges.

**Rotation du pepper** : `hash_version` permet de recalculer progressivement. Comme le HMAC
n'est pas inversible, une rotation nécessite soit `barcode_ciphertext`, soit un réimport des
badges. Cette contrainte est documentée pour le client : c'est le prix de l'irréversibilité.

### 3.2 Affichage

Nulle part dans le dashboard le numéro complet n'est affiché par défaut : partout
`******6789`. Un endpoint de révélation, réservé, audité et limité en débit, existe pour les
cas de support. Les exports CSV n'incluent jamais la valeur complète sans une option
explicite tracée.

### 3.3 Côté appareil

Voir doc 05 §3.1 : empreintes dérivées par appareil, jamais la valeur, jamais le pepper
serveur.

## 4. Sécurité de l'API

| Mesure | Mise en œuvre |
|---|---|
| Validation des entrées | DTO `class-validator`, `ValidationPipe` en `whitelist` + `forbidNonWhitelisted` |
| RBAC | Décorateur `@Roles()` + `RolesGuard` + `TenantGuard` (scoping par entreprise et par dépôt) |
| Limitation de débit | `@nestjs/throttler` adossé à Redis — global, par IP, par appareil, par valeur de badge |
| En-têtes | Helmet, CORS restreint aux origines du dashboard |
| Réponses uniformes | Les échecs d'authentification par badge renvoient un message unique, sans indiquer laquelle des neuf conditions a échoué |
| Journalisation | Logs structurés JSON (pino), `correlation_id`, `device_id`, `session_id` ; **jamais** de valeur de badge ni de jeton dans les logs |
| Documentation | Swagger sur `/api/docs`, désactivé en production ou protégé |
| Dépendances | `npm audit` et Dependabot en CI |

Limites de débit par défaut sur `/auth/barcode` : 10 tentatives/minute par appareil,
5 tentatives/minute par empreinte de badge, 30 échecs/heure par appareil déclenchant un
verrouillage temporaire et une alerte.

## 5. Sécurité Android

| Élément | Mise en œuvre |
|---|---|
| Stockage des jetons | Android Keystore, clés non exportables, StrongBox si disponible |
| Base locale | SQLCipher, clé dérivée dans le Keystore |
| Réseau | TLS uniquement, `cleartextTrafficPermitted="false"`, épinglage OkHttp **avec pin de secours** et date d'expiration (un épinglage sans plan de rotation immobilise une flotte) |
| Détection root | Best-effort (binaires `su`, `ro.debuggable`, Magisk connus) → événement, jamais blocage sans confirmation serveur |
| Détection débogage | `Debug.isDebuggerConnected()`, `ApplicationInfo.FLAG_DEBUGGABLE` |
| Détection ADB | `Settings.Global.ADB_ENABLED` → événement `ADB_ENABLED` |
| Intégrité de l'application | Vérification de la signature au démarrage ; **Play Integrity** si le client accepte l'enregistrement dans la Play Console |
| Journaux | Aucun log en `release`, aucune donnée personnelle en clair |
| Sauvegardes | `allowBackup="false"`, `dataExtractionRules` restrictives |
| Captures d'écran | `FLAG_SECURE` sur l'écran de scan, optionnel ailleurs |

## 6. RGPD — traduction technique

| Principe | Mise en œuvre concrète |
|---|---|
| Minimisation | Aucune position collectée hors session active ; intervalle adaptatif plutôt que suivi continu |
| Limitation des finalités | Les positions ne servent qu'aux règles de dépôt et aux alertes ; aucun calcul de score de conduite |
| Limitation de conservation | `retention_policies` par entreprise, purge automatique par partition |
| Droit d'accès et portabilité | `GET /users/:id/data-export` (JSON + CSV) |
| Droit à l'effacement | `POST /users/:id/anonymize` : suppression de l'identité, conservation d'agrégats non identifiants |
| Sécurité | Chiffrement au repos et en transit, cloisonnement multi-entreprises, audit |
| Traçabilité | `audit_logs` en insertion seule, y compris pour les consultations de position |
| Transparence | Écran d'information consultable sur le téléphone, indiquant ce qui est collecté et pendant quelle durée |

Le point le plus sensible reste **l'interdiction du suivi hors temps de travail**. Le choix
d'architecture « pas de session, pas de localisation » y répond directement, mais la
commande administrateur `LOCATE_NOW` sur un téléphone verrouillé constitue une exception :
elle exige une justification saisie par l'administrateur, elle est auditée, et elle peut être
désactivée entreprise par entreprise. **Recommandation : la laisser désactivée par défaut.**

## 7. Gestion des secrets

- Aucun secret dans Git : `.env.example` versionné, `.env` ignoré.
- Secrets requis : `DATABASE_URL`, `REDIS_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`,
  `BADGE_HMAC_PEPPER`, `BADGE_ENCRYPTION_KEY`, `DEVICE_MASTER_KEY`,
  `FCM_SERVICE_ACCOUNT_JSON`, `ENROLLMENT_TOKEN_SECRET`.
- En production : variables d'environnement injectées par l'orchestrateur, ou Docker secrets.
- Le keystore de signature Android est conservé hors du dépôt, avec sauvegarde chiffrée :
  **sa perte rend impossible toute mise à jour de la flotte**, et impose un factory reset
  général. C'est le point de défaillance unique le plus sous-estimé de ce type de projet.
