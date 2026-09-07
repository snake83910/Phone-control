# 19 — Déploiement d'applications

État : **fait et vérifié**, hors installation réelle qui exige un téléphone en
Device Owner.

Décision du client : **pas de Play Store**. L'architecture reste un DPC maison,
et la distribution d'applications passe par nos propres APK (docs/18 §2).

## 1. Ce que c'est vraiment

Une commande « installe l'APK qui se trouve là » est **une exécution de code
arbitraire sur la flotte entière**. C'est la fonction la plus puissante du
système, et de très loin la plus dangereuse : quiconque en détournerait l'usage
contrôlerait deux mille téléphones.

Tout ce qui suit découle de cette phrase. Ce n'est pas de la prudence
décorative : c'est la seule raison pour laquelle cette fonction est écrite
ainsi et pas en trois lignes.

## 2. Les trois verrous

### 2.1 Les empreintes sont calculées, jamais déclarées

À la réception du fichier, le serveur calcule lui-même :

- l'empreinte **SHA-256 du fichier**, pendant l'écriture sur disque ;
- l'empreinte **SHA-256 du certificat de signature**, lue dans le bloc de
  signature de l'APK.

Aucune des deux n'est saisie par l'opérateur. Une empreinte fournie par celui
qui dépose le fichier décrirait le fichier déposé, quel qu'il soit : elle ne
vérifierait rien du tout.

La lecture du bloc de signature est le **même code** que celui de l'atelier, qui
inscrit l'empreinte du DPC dans les QR codes de mise en service. Deux lectures
indépendantes du format finiraient par diverger, et la divergence ne se verrait
qu'au moment où un téléphone refuserait une installation légitime — ou en
accepterait une qu'il aurait dû refuser.

### 2.2 Le téléphone vérifie avant d'installer

Il ne fait confiance à rien qu'il n'ait constaté lui-même :

1. il calcule l'empreinte **pendant** le téléchargement, et la compare ;
2. il lit le certificat de l'APK téléchargé, et le compare ;
3. il compare à ce qui est déjà installé, et refuse un retour en arrière ou un
   changement de signataire.

La décision vit dans une fonction pure, `decideInstall`, testée sur douze
scénarios partagés. Ordonnée du plus décisif au moins décisif : une empreinte
qui ne correspond pas arrête tout, sans même lire le certificat d'un fichier
dont on sait déjà qu'il n'est pas le bon.

### 2.3 Tout est attribuable

Qui a déposé quel fichier, avec quelles empreintes. Qui l'a poussé, sur combien
de téléphones. Ce que chaque téléphone en a fait. L'administrateur qui a déposé
une application ne peut pas être supprimé de la base tant que la ligne existe.

## 3. Ce que ces verrous ne protègent pas

**Un serveur compromis peut pousser ce qu'il veut**, puisqu'il écrit lui-même
les empreintes attendues. C'est vrai de toute solution de gestion de parc, et il
vaut mieux l'écrire que le laisser deviner.

Ce qui est réellement protégé :

| Menace | Protégé ? |
|---|---|
| Fichier substitué entre le serveur et le téléphone | **oui** — empreinte du fichier |
| Fichier remplacé sur le disque du serveur | **oui** — empreinte recalculée à chaque téléchargement |
| APK d'un autre éditeur poussé par erreur | **oui** — empreinte du certificat |
| Retour à une version antérieure | **oui** — refusé, avec un message clair |
| Serveur lui-même compromis | **non** — inhérent au modèle |

Une protection s'ajoute sans que nous l'écrivions : Android refuse de remplacer
une application par une version signée d'une autre clé. Pour la mise à jour de
Phone Control lui-même, c'est la garantie la plus forte du dispositif, et elle
ne dépend pas de nous.

## 4. Parcours

1. L'opérateur dépose un APK depuis **Flotte › Applications**, avec un nom.
2. Le serveur écrit le fichier **en flux**, calcule les deux empreintes, lit le
   certificat, et affiche **qui a signé** l'APK. Un fichier qui n'est pas un APK
   signé est refusé au dépôt — mieux vaut là qu'après deux mille installations.
3. L'opérateur déploie. Une confirmation écrit en toutes lettres combien de
   téléphones sont concernés : c'est la dernière occasion de remarquer qu'on
   s'apprêtait à en toucher deux mille au lieu d'un.
4. Chaque téléphone télécharge avec **son propre jeton** — aucune route statique
   ne sert ce répertoire —, vérifie, installe, et rapporte.
5. Le premier téléphone qui installe rapporte l'identité réelle du paquet. Le
   serveur ne sait pas lire un manifeste binaire d'APK ; il l'ignore plutôt que
   de l'inventer. Une fois connue, elle devient une vérification de plus.

## 5. Détails qui ont demandé un choix

### 5.1 Le corps de la requête EST l'APK

Pas de formulaire multipart : un seul fichier, aucun autre champ, le nom voyage
en paramètre. Côté navigateur l'envoi tient en une ligne, côté serveur cela
évite une dépendance dont on n'utiliserait rien.

Le fichier n'est **jamais mis en mémoire** côté API : il est écrit au fur et à
mesure, son empreinte calculée dans le même passage, et la borne de taille
appliquée **pendant** la lecture. Recevoir cent cinquante méga-octets pour
ensuite les refuser reviendrait à n'avoir posé aucune borne.

### 5.2 Deux défauts trouvés dans la passerelle du tableau de bord

Le proxy du dashboard lisait les corps avec `request.text()`. Un décodage UTF-8
remplace silencieusement tout octet invalide par U+FFFD : le JSON n'en souffre
pas, un APK arrive corrompu. Corrigé en lecture binaire.

Il relayait aussi l'en-tête `Expect: 100-continue` tel quel, ce qui faisait
échouer la requête sortante avec un message qui ne disait rien de la cause. Le
cas ne se produit pas depuis un navigateur — il se produit au premier
diagnostic avec `curl`.

Le corps reste mis en mémoire dans la passerelle, et c'est assumé : la rotation
de jeton rejoue la requête, ce qu'un flux ne permet pas.

### 5.3 La cible est résolue par le serveur

Le tableau de bord n'énumère pas deux mille identifiants — la route de liste
s'arrête à deux cents par page. Un déploiement sans liste explicite vise **tous
les téléphones enrôlés** de l'entreprise, résolus côté serveur. Les appareils
non enrôlés en sont exclus : leur envoyer une commande qu'ils ne recevront
jamais ne ferait qu'encombrer la file.

### 5.4 Un refus n'est pas toujours une anomalie

Une commande rejouée sur un téléphone déjà à jour est le fonctionnement normal
du système. La remonter comme un incident noierait les vrais problèmes sous du
bruit. `isAnomaly` fait la part : *déjà à jour* passe en silence, tout le reste
se signale.

## 6. Vérifications

| Quoi | Combien | Où |
|---|---|---|
| Décision d'installation | 3 tests, 12 scénarios partagés | `AppInstallRulesTest` |
| Dépôt, déploiement, téléchargement | 17 tests | `apps/api/test/app-packages.e2e-spec.ts` |
| Lecture du bloc de signature | 9 tests | `packages/provisioning-payload/test/apk.spec.ts` |

Les tests bout en bout utilisent **l'APK réel du projet** — 82 Mo, construit par
Gradle. À défaut, la suite est ignorée plutôt que de vérifier une contrefaçon :
un faux APK ne dirait rien de la lecture d'un vrai bloc de signature.

Chaîne complète exercée sur les serveurs en fonctionnement : dépôt de l'APK de
82 Mo à travers la passerelle du tableau de bord — empreinte identique à
`sha256sum`, certificat lu (`CN=Android Debug`) —, affichage dans le catalogue,
confirmation nominative, et mise en file sur les trois téléphones enrôlés.

### 6.1 Un défaut de tests corrigé au passage

Ajouter ce fichier de tests a changé l'ordre dans lequel Jest exécute les
suites — il les trie par taille — et fait apparaître un défaut d'isolation
préexistant : le quota de scan **par badge** n'était jamais remis à zéro entre
les exécutions, parce qu'il est nommé d'après l'empreinte du code-barres et non
d'après l'appareil. Deux exécutions de la suite à moins d'une minute
d'intervalle partageaient donc le compteur, et un test qui scanne trois fois le
même numéro échouait à la seconde.

Le symptôme se déplaçait au gré de l'ordre des fichiers. C'est le genre de
défaut qu'on attribue à tort à la dernière chose écrite.

## 7. Ce qui reste à constater sur un téléphone

L'installation elle-même. Le code compile, l'APK se construit, mais aucune
installation n'a été faite par un vrai `PackageInstaller` — cela exige un
appareil en Device Owner, donc la Phase 5, elle-même conditionnée à
l'inscription du DPC auprès de Google (docs/18 §3).

Trois points à vérifier en priorité :

| Point | Pourquoi |
|---|---|
| Installation silencieuse effective | `STATUS_PENDING_USER_ACTION` ne doit jamais arriver. S'il arrive, le Device Owner n'est pas ce qu'on croit — le code le traite déjà comme un échec explicite. |
| Concordance des empreintes de certificat | Le serveur lit le bloc de signature de l'APK, le téléphone passe par `PackageManager`. Les deux doivent produire la même valeur ; c'est vérifié en théorie, pas encore sur un appareil. |
| Téléchargement de 80 Mo sur réseau mobile | À faire hors du dépôt, sur une connexion réelle. |
