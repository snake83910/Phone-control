# 16 — Blocage d'applications et prise en main à distance

Deux demandes formulées ensemble, dont les réponses n'ont rien à voir. La
première est faite et testée. La seconde dépend d'une décision qui n'est pas
technique.

Parc cible annoncé : **Samsung Galaxy A16**, très majoritairement.

## 1. Blocage d'applications — fait

### 1.1 Deux listes, deux effets

| Liste | Effet | Mécanisme Android |
|---|---|---|
| **Bloquées** | L'application disparaît du menu et ne se lance plus, session ouverte ou non. Elle n'est **pas** désinstallée : ses données restent. | `setApplicationHidden` |
| **Autorisées** | L'application peut s'ouvrir *à côté* de la nôtre pendant une session. Hors de cette liste, rien ne s'ouvre en mode kiosque. | `setLockTaskPackages` |

Les deux se pilotent depuis **Flotte › Applications**. Un nom de paquet par
ligne — c'est la forme sous laquelle un administrateur les obtient réellement,
en les copiant depuis l'adresse d'une fiche Play Store.

Le remplacement est complet, jamais fusionné : retirer une ligne fait
réapparaître l'application. Sans cette propriété, un blocage erroné se
réparerait téléphone par téléphone, en atelier.

### 1.2 Ce que le système refuse de bloquer

Seize paquets sont hors d'atteinte, quelle que soit la configuration
(`packages/state-machine-spec/scenarios/app-policy.json`). Ils se répartissent
en quatre motifs, et chacun décrit une panne concrète :

| Motif | Exemples | Ce qui arriverait |
|---|---|---|
| Le téléphone ne tient plus debout | `android`, `com.android.systemui`, lanceurs | Écran noir, ou plus d'écran d'accueil |
| Plus d'appels | `com.android.phone`, `com.android.server.telecom`, composeurs Samsung | Le chauffeur ne peut plus appeler le dépôt |
| Sécurité publique | `com.android.cellbroadcastreceiver` | Plus d'alerte FR-Alert |
| **Plus de réparation possible** | `com.google.android.gms`, `com.android.vending`, installeurs | La notification qui achemine les commandes à distance disparaît : le téléphone devient irrécupérable autrement qu'en main |

Le dernier motif est le plus important. Masquer les services Google Play, c'est
couper la branche sur laquelle on est assis — la commande de déblocage passe
justement par là.

Le refus est **doublé** : le serveur refuse la saisie, le téléphone refuse
l'application. La liste vit dans un fichier partagé et deux tests de parité
(un en TypeScript, un en Kotlin) échouent si les deux côtés divergent. Une
divergence signifierait un tableau de bord affichant un blocage accepté et des
appareils qui le refusent en silence.

### 1.3 Intention et constat, jamais confondus

C'est le point de conception qui structure toute la fonctionnalité, et il
découle directement de la règle §67.

- Le tableau de bord enregistre une **consigne**.
- Chaque téléphone rapporte ce qu'il a **réellement** masqué, relu du système
  et non déduit de ce qu'on lui a demandé.

Les deux sont stockés séparément (`device_settings.blocked_apps` d'un côté,
`devices.app_policy_report` de l'autre). La fiche d'un appareil affiche le
constat, et dit en toutes lettres « aucune application n'est masquée sur ce
téléphone » quand l'application n'y est pas Device Owner.

Un système qui les confondrait afficherait « bloquée » pour une application
parfaitement ouvrable — et sur un téléphone sans Device Owner, ce serait le cas
général.

Cinq motifs de refus remontent, traduits en conséquence plutôt qu'en jargon :

| Motif | Affiché comme |
|---|---|
| `SELF` | ignorée : c'est l'application de gestion elle-même |
| `PROTECTED` | refusée : la masquer rendrait le téléphone inutilisable |
| `NOT_INSTALLED` | absente de ce téléphone — vérifiez le nom du paquet |
| `CONFLICT` | présente dans les deux listes : bloquée, corrigez la consigne |
| `SYSTEM_REFUSED` | Android a refusé le masquage sur ce modèle |

`SYSTEM_REFUSED` mérite un mot : `setApplicationHidden` renvoie `false` sans
lever d'exception quand le système refuse. Ignorer cette valeur de retour aurait
produit exactement le mensonge que §67 interdit.

### 1.4 Vérifications

| Quoi | Combien | Où |
|---|---|---|
| Règles pures (plan de blocage) | 6 tests, 18 scénarios partagés | `AppPolicyRulesTest` |
| Parité de la liste protégée | 3 tests | `app-policy.spec.ts` |
| Route serveur, bout en bout | 15 tests | `app-policy.e2e-spec.ts` |
| Migration de la base locale | 2 tests | `MigrationTest` |

La chaîne complète est couverte : l'administrateur enregistre une politique,
elle part dans la synchronisation, le téléphone rapporte son constat.

Le test de migration a été **vérifié non complaisant** : introduire une faute
dans le SQL le fait échouer. Il n'est pas décoratif — la fabrique refuse
volontairement `fallbackToDestructiveMigration`, donc une migration fausse ne
perd pas des données en silence, elle empêche l'application de démarrer, sur
tous les téléphones à la fois, le jour de la mise à jour.

### 1.5 Ce qui reste conditionné au Device Owner

Rien de tout cela ne masque quoi que ce soit tant que l'application n'est pas
administrateur de l'appareil. Ce privilège s'accorde **à la mise en service, et
jamais après coup** : c'est la Phase 5, bloquée sur un téléphone réinitialisable.

Le code est écrit et compilé ; il n'a pas été exécuté sur un appareil où le
privilège existe.

## 2. Prise en main à distance — décision à prendre

### 2.1 Trois choses qu'on appelle du même nom

| Ce qu'on veut | État |
|---|---|
| **Agir à distance** — verrouiller, déverrouiller, redémarrer, effacer, localiser, forcer une déconnexion | Déjà en place (`CommandType`) |
| **Voir l'écran** du chauffeur | Possible, mais avec son accord explicite à chaque session |
| **Toucher l'écran** à sa place | Exige une licence Samsung payante |

La première est faite. Les deux autres demandent un arbitrage.

### 2.2 Voir l'écran : possible, avec accord

Android n'offre à aucun administrateur, Device Owner compris, le droit de
capturer l'écran en silence. `MediaProjection` exige que l'utilisateur touche
une boîte de dialogue système, **à chaque session**.

Ce n'est pas un obstacle à contourner : c'est ce qui distingue une assistance
d'une surveillance. Pour le cas d'usage réel — « le chauffeur ne s'en sort pas,
je regarde son écran » — cet accord est plutôt un atout : il rend l'intervention
traçable et acceptable devant les représentants du personnel.

Réalisable sans licence, sans Knox, sans contournement.

### 2.3 Toucher l'écran : Samsung Knox, et rien d'autre

Aucune API Android publique ne permet d'injecter des appuis à distance. Les
solutions qui le font sur Samsung passent toutes par le **Knox SDK**. Deux voies
existent, et la documentation Samsung dit ceci :

**a) Intégrer le Knox SDK dans notre propre application.**

- Permission `com.samsung.android.knox.permission.KNOX_REMOTE_CONTROL`.
- **Licence KPE Premium** obligatoire — payante, par appareil.
- Depuis **Android 15 (Knox 3.11)**, réservé aux applications tournant en mode
  Android Enterprise géré, ce qui est notre cas (Device Owner). L'autorisation
  s'accorde en déclarant le paquet et la portée « REMOTE CONTROL » via Knox
  Service Plugin.
- **Point important : le *remote viewing* de Knox est déprécié depuis l'API 35
  (Knox SDK 3.8).** Seule l'injection reste active. Autrement dit, même avec
  Knox, l'image de l'écran devrait venir d'ailleurs — de `MediaProjection`, donc
  avec l'accord du chauffeur.

**b) Acheter Knox Remote Support.**

Le produit packagé de Samsung, fondé sur l'agent RSupport. Il s'installe via un
EMM, y compris un EMM tiers, et couvre vision et contrôle. Il demande une
licence Knox Suite et introduit un composant qui n'est pas le nôtre.

### 2.4 Ce qu'il faut vérifier avant de s'engager

Le Galaxy A16 n'apparaît nommément dans aucune des pages consultées. Sa
compatibilité **KPE** et **Knox Mobile Enrollment** se vérifie sur les listes
officielles de Samsung, et cette vérification précède tout engagement de
budget :

- <https://www.samsungknox.com/en/knox-platform/supported-devices/kpe>
- <https://www.samsungknox.com/en/knox-platform/supported-devices/kme>

Il faut aussi vérifier la version d'Android livrée sur les appareils achetés :
l'A16 sort sous Android 14, et les règles Knox 3.11 décrites plus haut ne
s'appliquent qu'à partir d'Android 15. Une flotte à jour y basculera.

### 2.5 Recommandation

Commencer par **la vision avec accord** (§2.2) : elle couvre la quasi-totalité
du besoin d'assistance, ne coûte rien, n'ajoute aucune dépendance, et se défend
sans difficulté sur le plan RGPD.

Ne financer une licence Knox que si l'exploitation constate qu'il manque
réellement le contrôle du doigt — et sachant que, viewing déprécié, elle
n'évitera pas la boîte de dialogue de partage d'écran.

Ce qu'il ne faut **pas** faire, et qui sera refusé si on le demande :
détourner un service d'accessibilité pour injecter des appuis. Cela fonctionne,
c'est ce qu'emploient certains outils, et c'est un contournement des protections
Android au sens de §67 — sans compter le retrait du Play Store.

## 3. Samsung Galaxy A16 — points à surveiller

| Point | Pourquoi |
|---|---|
| **Optimisation de batterie Samsung** | Les gammes A appliquent une mise en veille agressive des applications d'arrière-plan. C'est le premier suspect si le suivi de position s'interrompt. À constater sur appareil, pas à supposer. |
| **Android livré** | A16 : Android 14 à la sortie. `minSdk = 28` du projet est largement couvert. |
| **Knox Mobile Enrollment** | S'il est compatible, il remplace avantageusement le QR code d'atelier pour un parc entier. |
| **Compatibilité KPE** | À confirmer avant tout engagement sur la prise en main à distance (§2.4). |

## 4. Sources

- [Remote control — Knox SDK](https://docs.samsungknox.com/dev/knox-sdk/features/mdm-providers/device-management/remote-control/remote-control/)
- [Remote viewing — Knox SDK](https://docs.samsungknox.com/dev/knox-sdk/features/mdm-providers/device-management/remote-control/remote-viewing/)
- [Autoriser les permissions de contrôle à distance sur Android 15+](https://docs.samsungknox.com/admin/knox-platform-for-enterprise/knox-service-plugin/kbas/kba-1674-how-to-authorize-remote-control-permissions-for-android-15-and-higher/)
- [Knox Remote Support](https://docs.samsungknox.com/admin/knox-remote-support/)
- [Compatibilité Knox Platform for Enterprise](https://www.samsungknox.com/en/knox-platform/supported-devices/kpe)
