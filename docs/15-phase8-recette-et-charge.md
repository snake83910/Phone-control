# 15 — Phase 8 : recette et charge

État : **les huit tests de recette passent**, le banc de charge existe et a été exécuté.
Reste la matrice de terminaux, qui exige du matériel.

## 1. Les huit tests de la spécification

Ils étaient déjà automatisés — écrits en Phase 2, sous les noms que leur donnait la
spécification (§59). Ils vivent dans deux fichiers et s'exécutent d'un coup :

```bash
pnpm --filter @phone-control/api test:recette
```

| # | Ce qu'il établit | Exigence |
|---|---|---|
| 1 | Badge valide sur un téléphone autorisé : **accès autorisé**, session ouverte | E2, E3 |
| 2 | Badge inconnu : **accès refusé**, tracé et alerté | E3 |
| 3 | Badge valide mais téléphone non autorisé : **accès refusé** | E3 |
| 4 | Entrée au dépôt à 18 h 15 : le téléphone passe à `RETURNED` | E5 |
| 5 | Sortie à 19 h 00 après un retour : **alerte** | E5 |
| 6 | Commande de verrouillage : émise, récupérée, acquittée | E6 |
| 7 | Synchronisation : configuration, dépôt et liste hors ligne | E4 |
| 8 | Rejeu d'un lot après une réponse perdue : **aucun doublon** | E4, E9 |

Deux exigences ne peuvent pas être vérifiées ainsi, et il faut le dire :

- **E1** — « le téléphone est inutilisable tant qu'aucun badge valide n'a été scanné » ;
- **E7** — « l'utilisateur ne peut pas contourner l'application ».

Les deux reposent sur le Device Owner et le mode Lock Task. Elles ne se prouvent pas par un
test automatisé : elles se constatent, en essayant de sortir du kiosque sur un téléphone
réel. C'est la Phase 5.

## 2. Banc de charge

```bash
pnpm --filter @phone-control/api charge
pnpm --filter @phone-control/api charge -- --devices 500 --batch 200
```

Il ne mesure pas « combien de requêtes par seconde », chiffre sans signification hors du
matériel qui le produit. Il mesure les trois choses qui comptent pour ce système : le scan
de badge, parce qu'un chauffeur attend devant l'écran ; le lot de synchronisation, parce que
deux mille téléphones le remontent toutes les quinze minutes ; le heartbeat, parce que c'est
la requête la plus fréquente du parc.

### 2.1 Résultats mesurés

500 téléphones, lots de 200 événements, 32 requêtes simultanées, sur le poste de
développement (PostgreSQL en conteneur, API montée dans le processus de mesure) :

| Chemin | p50 | p95 | p99 | Débit |
|---|---|---|---|---|
| Heartbeat | 50 ms | 78 ms | 88 ms | 616 req/s |
| Synchronisation (200 événements) | 289 ms | 391 ms | 440 ms | 106 req/s — **21 288 événements/s** |
| Scan de badge (refus) | 29 ms | 37 ms | 38 ms | 260 req/s |

100 000 positions ont été insérées en un peu moins de cinq secondes.

### 2.2 Ce que ces chiffres disent d'un parc de 2 000 téléphones

| Charge attendue | Besoin | Mesuré |
|---|---|---|
| Heartbeat toutes les 5 min | 6,7 req/s | 616 req/s |
| Synchronisation toutes les 15 min | 2,2 req/s | 106 req/s |
| Scan de badge, deux par chauffeur et par jour | négligeable | 260 req/s |

La marge est de deux ordres de grandeur. Le point de tension n'est donc pas le débit, mais
le **volume accumulé** : deux mille téléphones produisent environ trois cents millions de
positions par an, ce à quoi répond le partitionnement mensuel de `location_events` et la
purge par `DROP PARTITION` (docs/03).

### 2.3 Ce que ces chiffres ne disent pas

L'API est montée **dans le processus de mesure** : ni pile réseau, ni proxy inverse, ni TLS,
ni latence mobile. C'est délibéré — on cherchait le coût du code et de la base. Un banc de
charge sur l'infrastructure réelle donnera des nombres différents, et c'est celui-là qui
comptera pour un dimensionnement.

Le scan de badge est mesuré **sur le refus**, chemin le plus coûteux — recherche par
empreinte, journalisation, alerte de sécurité — et celui qu'un attaquant sollicite. C'est la
borne haute, pas le cas courant.

## 3. Défaut trouvé au banc de charge

Le premier essai à 500 téléphones s'est arrêté net : **HTTP 429**.

La limitation de débit comptait par **adresse IP** — le comportement par défaut de
`@nestjs/throttler`. Or sur le terrain, quelques centaines de téléphones partagent l'adresse
publique de leur opérateur mobile : c'est le fonctionnement normal du NAT d'opérateur. Le
parc entier épuisait donc un seul quota de cent vingt requêtes par minute.

Cela ne se serait pas manifesté comme une panne franche, mais comme des téléphones « qui ne
remontent plus », par intermittence, en fonction de qui parle en même temps — le genre de
symptôme qu'on met des semaines à attribuer.

Une requête authentifiée est désormais comptée sur **le porteur du jeton** : chaque
téléphone, chaque administrateur a son propre quota. Les requêtes anonymes — connexion,
enrôlement — restent comptées par adresse, car c'est là que la limitation protège vraiment :
elle empêche une force brute de faire travailler Argon2 des milliers de fois.

Le sujet du jeton est lu **sans vérifier la signature**, et c'est assumé : la vérification a
lieu juste après, dans le garde d'authentification. Un attaquant qui forgerait un sujet ne
gagnerait qu'un compteur distinct, sans accès ni traitement coûteux. Vérifier ici
reviendrait à faire précéder la limitation de débit par ce qu'elle est censée protéger.

## 4. Ce qui reste, et pourquoi

| Point | Bloqué par |
|---|---|
| **Matrice de terminaux** | Plusieurs téléphones, de constructeurs différents. C'est le seul moyen de savoir si Samsung, Xiaomi ou Oppo tuent le service de localisation — aucune API ne le garantit. |
| **E1 et E7** (kiosque inviolable) | Un téléphone réinitialisable, Device Owner attribué. Ces exigences se constatent, elles ne se testent pas. |
| **Banc de charge sur l'infrastructure réelle** | Un environnement de préproduction avec proxy inverse et TLS. |
| **Arbitrage RGPD** | Le client. Information des chauffeurs, consultation des représentants du personnel, analyse d'impact. Ce n'est pas technique, et cela précède la mise en production. |
