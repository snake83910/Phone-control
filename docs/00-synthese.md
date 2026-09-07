# 00 — Synthèse de la Phase 1

Document d'entrée. Il rassemble les décisions à valider, les points où j'ai tranché
différemment de la spécification, les risques majeurs et les questions ouvertes.

## 1. Décisions techniques structurantes

| # | Décision | Motif |
|---|---|---|
| D1 | **DPC propriétaire** (l'application est à la fois Device Owner, launcher et application métier) plutôt qu'Android Management API | Seule voie permettant un écran de verrouillage métier comme véritable écran d'accueil, sans dépendance à un compte Google entreprise (doc 04 §1) |
| D2 | **Séparer l'authentification de l'appareil de la session du chauffeur** | Un téléphone verrouillé doit rester joignable pour recevoir un ordre de déverrouillage (doc 02 §2) |
| D3 | **Moteur de geofencing propriétaire**, pas `GeofencingClient` | Maîtrise de l'hystérésis, du seuil de confiance et de la traçabilité des décisions (doc 06 §1) |
| D4 | **Badges stockés en HMAC-SHA256 avec pepper**, pas en Argon2 ni en clair | Recherche par index obligatoire à chaque scan ; le badge n'est pas un mot de passe (doc 07 §3) |
| D5 | **Empreintes de badge dérivées par appareil** pour le mode hors ligne | Une liste extraite d'un téléphone volé est inutilisable ailleurs (doc 05 §3.1) |
| D6 | **FCM en canal rapide, polling adaptatif en canal de secours permanent** | Le système doit fonctionner sur des terminaux sans Play Services (doc 01 §2.5) |
| D7 | **`location_events` partitionnée par mois**, purge par `DROP PARTITION` | 300 millions de lignes à un an pour 2 000 téléphones ; c'est aussi le mécanisme de purge RGPD (doc 03) |
| D8 | **Aucune localisation hors session active** | Exigence CNIL autant qu'économie de batterie (doc 07 §6) |
| D9 | **Machine à états spécifiée une fois, implémentée deux fois, testée par des scénarios JSON communs** (Jest + JUnit) | Seul moyen fiable d'empêcher la logique Kotlin et la logique TypeScript de diverger (doc 02 §6) |
| D10 | **Double barrière multi-tenant** : extension Prisma + RLS PostgreSQL | Une seule barrière applicative finit toujours par être contournée par un oubli de `where` (doc 03 §4) |
| D11 | **MapLibre GL** plutôt que Google Maps pour le dashboard | Pas d'enfermement propriétaire, coût maîtrisé à l'échelle |
| D12 | **API et worker en processus distincts** | Le pic de 22h ne doit pas dégrader la disponibilité de l'API |

## 2. Écarts assumés par rapport à la spécification

Quatre points où j'ai délibérément fait autrement, avec la justification :

1. **`ALERT` n'est pas un état de la machine à états**, mais un indicateur superposé. Un
   téléphone en alerte reste `RETURNED` ou `ACTIVE`. Traiter l'alerte comme un état bloquant
   rendrait ingérable le cas — fréquent — du chauffeur légitimement reparti.

2. **Une table `admins` distincte de `users`.** Les chauffeurs n'ont pas de mot de passe et
   ne se connectent jamais au dashboard ; les administrateurs n'ont pas de badge. Les fusionner
   produirait une table à moitié vide et un modèle de permissions confus.

3. **Ajout d'un état `RETURNED` sur la session, et pas seulement sur l'appareil.** L'exigence
   parle de « téléphone retourné », mais le retour est un fait qui appartient à la journée de
   travail d'une personne. Le porter sur la session permet l'historique et les statistiques ;
   l'appareil conserve une copie dénormalisée pour l'affichage de la carte.

4. **Ajout d'une table `device_credentials` et d'une clé Keystore par appareil**, non
   demandées. Sans elles, un jeton d'appareil volé est réutilisable indéfiniment sur un autre
   matériel.

## 3. Les cinq risques à connaître

1. **RGPD et droit du travail** — la géolocalisation de salariés impose information,
   consultation des représentants du personnel, interdiction du suivi hors temps de travail et
   très probablement une AIPD. L'architecture y répond techniquement, mais l'arbitrage
   juridique appartient au client et doit précéder la mise en production. *C'est le risque le
   plus élevé du projet, et il n'est pas technique.*

2. **Le badge Code 128 est photocopiable.** Le système est une identification assortie
   d'autorisations contextuelles, pas une authentification forte. Cette limite doit être
   énoncée au client, pas masquée.

3. **La gestion agressive de la batterie par les constructeurs** peut tuer le service de
   localisation. Aucune API ne garantit ce point ; seule une matrice de tests par modèle le
   validera.

4. **Le provisioning exige un factory reset par téléphone.** Environ 10 minutes par unité,
   sauf zero-touch — dont le prérequis est commercial.

5. **La perte du keystore de signature Android** immobiliserait toute mise à jour de la
   flotte et imposerait un factory reset général. À sauvegarder dès la Phase 4.

## 4. Ce qui est impossible, et qu'il faut assumer

Ni l'extinction du téléphone, ni le retrait de la carte SIM, ni la copie d'un badge ne
peuvent être empêchés. Le système les **détecte** et **alerte** ; il ne les bloque pas. De
même, sans Device Owner réellement attribué, l'application n'est qu'une application ordinaire :
le dashboard affichera « Device Owner : non confirmé » plutôt qu'une protection fictive.
Détail complet en doc 01 §3.

## 5. Questions ouvertes — réponses attendues avant la Phase 2

| # | Question | Impact | Ma recommandation |
|---|---|---|---|
| Q1 | **Format exact des badges** : longueur, jeu de caractères, zéros de tête significatifs, préfixe éventuel, présence d'un chiffre de contrôle | **Bloquant.** Fige la normalisation avant hachage, irréversible ensuite | Fournir 5 à 10 valeurs réelles anonymisées |
| Q2 | Faut-il un **repli de saisie manuelle** du numéro par un superviseur ? | Un badge abîmé immobilise sinon un téléphone | Oui, avec code superviseur et audit systématique |
| Q3 | Un chauffeur peut-il avoir **plusieurs sessions simultanées** sur plusieurs téléphones ? | Contrainte d'unicité en base | Non — une session à la fois, tentative concurrente = alerte |
| Q4 | Que fait le téléphone à **l'expiration d'une session** en pleine journée ? | Un verrouillage inopiné en tournée est inacceptable | Durée par défaut 16 h, avertissement à 30 min, jamais de verrouillage silencieux |
| Q5 | Politique **« non retourné »** : alerte si aucun retour à `lock_time` ? | Table `alerts`, type `NOT_RETURNED` | Oui, sévérité `MEDIUM`, activable par dépôt |
| Q6 | La commande **`LOCATE_NOW` sur téléphone verrouillé** est-elle autorisée ? | Point RGPD sensible | Désactivée par défaut, activable avec justification obligatoire et audit |
| Q7 | **Volumétrie cible** à 12 mois : nombre d'entreprises, de dépôts, de téléphones | Dimensionnement, partitionnement, coût d'hébergement | — |
| Q8 | **Modèles de téléphones** retenus, et sont-ils achetés via un revendeur zero-touch ? | Conditionne la stratégie de provisioning | Zero-touch dès 100 unités |
| Q9 | Firebase est-il **acceptable** (données transitant par Google) ? | Sinon, polling seul, réactivité de 30 s | FCM avec charge utile vide (simple signal de réveil), aucune donnée métier |
| Q10 | Applications autorisées en mode kiosque, liste initiale | Configuration par défaut | Téléphone, Messages, Maps, plus l'application métier |

## 6. Ce que je propose de faire maintenant

Phase 1 terminée : les huit documents sont dans `docs/`. Rien n'a encore été codé, comme
demandé.

**Pour démarrer la Phase 2, j'ai besoin au minimum de Q1.** Les autres questions ont une
réponse par défaut raisonnable, indiquée ci-dessus, et peuvent être arbitrées en cours de
route sans rupture.

La Phase 2 produira, dans l'ordre :

1. le squelette du monorepo et le `docker-compose.yml` (PostgreSQL + PostGIS, Redis) ;
2. le schéma Prisma complet et la première migration ;
3. les jeux de données de démonstration ;
4. l'authentification administrateur, le RBAC et le cloisonnement multi-entreprises ;
5. `POST /auth/barcode` avec ses neuf contrôles et sa suite de tests ;
6. sessions, commandes, heartbeat, synchronisation ;
7. le moteur de règles serveur (geofence et horaires) avec les scénarios JSON partagés ;
8. Swagger et une suite Jest exécutable en une commande.
