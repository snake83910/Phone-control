# Scénarios de référence du moteur de règles

Ces fichiers JSON sont **la spécification exécutable** de la logique métier.

Le moteur existe en deux implémentations — TypeScript côté serveur, Kotlin côté Android —
parce qu'il doit fonctionner hors ligne sur le téléphone tout en restant sous l'autorité du
serveur. Deux implémentations d'une même règle finissent toujours par diverger, sauf si
elles sont contraintes par le même jeu de cas.

C'est le rôle de ce paquet : les mêmes fichiers alimentent la suite Jest de l'API
(`apps/api/src/rules/scenarios.spec.ts`) et la suite JUnit du module Android
(`apps/android/core-rules/src/test/.../SharedScenariosTest.kt`), toutes deux exécutées en
intégration continue.

## Fichiers

| Fichier | Ce qu'il vérifie |
|---|---|
| `geofence-classification.json` | Classification d'un point GPS par rapport à une zone, avec son incertitude et l'hystérésis. C'est ce qui empêche les fausses alertes. |
| `depot-rules.json` | Décisions métier sur une transition confirmée : retour au dépôt, sortie après retour, alerte. |
| `schedule.json` | Résolution des règles horaires : fuseaux, changements d'heure, jour opérationnel, surcharges hebdomadaires et jours fériés. |
| `badge-hash-vectors.json` | Empreintes de référence des badges. Vérifiées par Jest **et** par JUnit : elles prouvent qu'un badge accepté en ligne le sera aussi hors ligne. |
| `geofence-engine.json` | Moteur local du téléphone : filtrage des mesures, hystérésis, confirmation multi-échantillons. **Android uniquement** — le serveur ne reçoit que des transitions déjà confirmées, il n'a pas d'équivalent à contraindre. |
| `pinning.json` | Épinglage de certificat : quand il s'applique, quand il se lève, et pourquoi il ne doit jamais faire échouer une connexion. **Android uniquement**. |
| `integrity.json` | Intégrité du terminal : ce qui constitue un constat, avec quelle sévérité, et à quelle cadence il est répété. **Android uniquement**. La règle la plus importante y est visible comme une donnée : rien de tout cela ne bloque quoi que ce soit. |

## Règle de contribution

Toute correction de bug dans le moteur commence par **ajouter le cas ici**, dans le fichier
correspondant. Un correctif sans scénario n'est pas protégé contre la régression, et surtout
ne sera pas répercuté sur l'autre implémentation.
