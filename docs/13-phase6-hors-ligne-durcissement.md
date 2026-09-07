# 13 — Phase 6 : hors ligne et durcissement (livrée)

État : **terminée et vérifiée**. 128 tests serveur, 55 tests Kotlin sur la JVM, **11 tests
instrumentés sur un vrai Android**, APK de release construit à 22,7 Mo.

Le fait marquant de cette phase n'est pas une fonctionnalité, c'est un moyen : un
**émulateur Android** était disponible sur le poste. Des choses qui ne pouvaient jusqu'ici
qu'être écrites et espérées ont pu être exécutées et constatées — le chiffrement de la base
locale, et le calcul d'empreinte par une clé résidente du Keystore, noté comme non vérifié
en [docs/11 §6](11-phase4-android.md).

Un émulateur n'est pas un téléphone : il ne dit rien du Device Owner, de la caméra, du GPS
ni des gestionnaires de batterie constructeurs. La Phase 5 reste bloquée sur du matériel.

## 1. Ce que cette phase ajoute

La Phase 4 avait déjà livré l'essentiel du fonctionnement hors ligne : file d'événements
persistante, empreintes de badge par appareil, authentification sans réseau, revalidation de
session à la reconnexion. Restaient les points de durcissement.

| Point | État |
|---|---|
| Base locale chiffrée (SQLCipher) | livré, vérifié sur émulateur |
| Conversion d'une base en clair héritée | livré, vérifié sur émulateur |
| Empreinte de badge par clé du Keystore | **vérifié** sur émulateur — était le point ouvert de docs/11 §6 |
| Détection root / ADB / débogueur / signature | livré, politique testée sans téléphone |
| Compression des lots de synchronisation | livré des deux côtés, testé des deux côtés |
| Horodatage suspect (`clock_suspect`) | livré côté serveur, testé |
| `FLAG_SECURE`, journaux supprimés en release | livré |

## 2. Base locale chiffrée

### 2.1 Une phrase hexadécimale, et une seule couche

La phrase secrète fait 256 bits, tirés au hasard au premier démarrage, et vit dans le
magasin sécurisé — des préférences chiffrées dont la clé maîtresse est dans l'Android
Keystore, en StrongBox si le terminal en dispose.

Elle est **hexadécimale** et non binaire, parce qu'elle doit apparaître telle quelle dans un
`ATTACH DATABASE … KEY '…'` au moment de convertir une base en clair. Des octets quelconques
y poseraient un problème d'échappement — apostrophes, octets nuls — dont la moindre erreur
produirait une base illisible. Sur soixante-quatre caractères hexadécimaux, la question ne
se pose pas, et l'entropie est identique.

**Aucune seconde clé ne l'enveloppe.** SQLCipher a besoin de la phrase en clair pour ouvrir
la base : elle existe donc en mémoire, quelle que soit sa protection au repos. Une enveloppe
n'aurait rien changé à cela, et aurait ajouté un mode de panne — une clé invalidée par une
mise à jour du système rend la base définitivement illisible. Un seul point de défaillance
vaut mieux que deux.

### 2.2 Ce que le chiffrement protège, et ce qu'il ne protège pas

Il protège la lecture du fichier par extraction physique ou par une sauvegarde : positions,
badges en cache, file d'événements. Il ne protège pas contre un attaquant qui exécute déjà
du code en tant que l'application — celui-là lit la mémoire du processus.

C'est la limite de tout chiffrement au repos. Elle est écrite dans le code, à l'endroit où
quelqu'un pourrait croire le contraire.

### 2.3 Trois situations, une seule ordinaire

1. **Base chiffrée existante ou première installation.** Cas normal.
2. **Base en clair héritée.** Convertie sur place par `sqlcipher_export`, avant que Room ne
   l'ouvre. La file d'événements non synchronisés ne doit pas disparaître à l'occasion d'une
   mise à jour : ce sont des preuves, pas un cache ([docs/11 §4.2](11-phase4-android.md)).
   Le fichier chiffré est écrit **à côté**, l'original n'est supprimé qu'après ; une coupure
   au mauvais moment laisse soit l'ancien fichier intact, soit les deux, jamais rien.
3. **Magasin sécurisé indisponible** — keystore corrompu, restauration d'image. La base est
   alors ouverte **en mémoire**. L'application démarre, affiche « téléphone non enrôlé », et
   rien de sensible ne touche le disque en clair. Le terminal est de toute façon inutilisable
   sans ses identifiants ; autant ne pas aggraver la situation en abandonnant le chiffrement.

### 2.4 Ce que les tests instrumentés établissent

Sur émulateur, donc sur un vrai Android :

- le fichier écrit **n'est plus une base SQLite lisible** — ni son en-tête, ni son contenu ;
- une base chiffrée **ne s'ouvre pas** avec une autre phrase ;
- une base en clair de vingt-cinq événements est convertie **sans en perdre un seul** ;
- sans phrase disponible, **aucun fichier n'est créé**.

Ces tests ne pouvaient pas tourner sous Robolectric : SQLCipher est une bibliothèque native,
et il n'en existe pas de version pour la JVM du poste.

### 2.5 Le coût, et ce qu'on en a fait

SQLCipher embarque une bibliothèque native par architecture. Les quatre variantes pesaient
20 Mo à elles seules, et l'APK de release est passé de 26 à 45,6 Mo.

La moitié de ce poids servait x86 et x86_64, c'est-à-dire des émulateurs — que l'on ne
provisionne pas. Le release ne conserve donc que `arm64-v8a` et `armeabi-v7a` : **22,7 Mo**,
soit moins qu'avant l'ajout du chiffrement, R8 ayant par ailleurs gagné du terrain.

L'APK de debug garde les quatre : c'est sur émulateur que tournent les tests instrumentés.

## 3. Intégrité du terminal : observer, qualifier, signaler

### 3.1 Jamais bloquer

La détection de compromission ne verrouille rien. Elle produit des événements de sécurité ;
l'arbitrage appartient au serveur, qui seul a le contexte — un téléphone d'atelier a de
bonnes raisons d'avoir le débogage USB actif, un téléphone de tournée non.

La raison est simple : une détection *best-effort* qui verrouillerait transformerait un faux
positif en chauffeur bloqué au bord de la route.

### 3.2 Ce que ce contrôle ne peut pas faire

Un terminal réellement rooté masque chacun de ces indices : Magisk en mode furtif, `su`
renommé, propriétés système réécrites. Ce qui est détecté, ce sont les cas ordinaires — un
téléphone rooté sans précaution, des options développeur laissées actives, un débogueur
branché. C'est utile, et ce n'est pas une garantie ; le prétendre donnerait une fausse
assurance, ce qui est pire que rien.

### 3.3 Deux distinctions qui comptent

**« Non vérifié » n'est pas « faux ».** Une signature d'APK que l'on n'a pas pu lire produit
`null`, pas un constat. Les confondre déclencherait une alerte `CRITICAL` après un simple
incident de lecture, et apprendrait à l'exploitation à ignorer ces alertes.

**Un constat n'est pas répété indéfiniment.** Sans cadence, un téléphone dont les options
développeur restent actives émettrait quatre-vingt-seize événements par jour pour une
information constante. Un constat nouveau part immédiatement ; un constat déjà remonté
attend vingt-quatre heures ; un constat disparu est oublié, pour que son retour soit de
nouveau immédiat.

La politique et sa cadence vivent dans
`packages/state-machine-spec/scenarios/integrity.json` et s'exécutent sur la JVM, sans
téléphone. Elles se relisent comme une donnée : changer une sévérité est un changement
visible, pas une ligne perdue dans une condition.

### 3.4 Le maillon faible, dit

L'empreinte de signature attendue est fixée à la compilation. Celui qui reconstruit
l'application peut donc aussi changer la valeur attendue : ce contrôle n'attrape que le
repackaging naïf. La forme robuste — empreinte transmise par le serveur à l'enrôlement — est
notée en Phase 7, avec l'épinglage de certificat.

## 4. Compression des lots

Un lot de cinq cents positions est du JSON très répétitif : mêmes noms de champs, mêmes
préfixes d'identifiants, coordonnées voisines. Le gain se paie en données mobiles réelles,
sur des téléphones qui roulent toute la journée — mesuré à plus de **quatre cinquièmes** sur
un lot de test.

Les deux moitiés du contrat sont tenues et testées séparément : l'interceptor OkHttp côté
téléphone, le crochet `preParsing` côté Fastify. **Sans l'une, activer l'autre casserait la
synchronisation de tout le parc d'un seul coup** — d'où l'insistance.

Deux détails ont coûté du temps et méritent d'être écrits :

- Fastify compare la longueur reçue à l'en-tête `Content-Length`. Le flux décompressé étant
  plus long, chaque lot compressé était rejeté en 400 tant que `receivedEncodedLength`
  n'était pas tenu à jour. L'erreur n'a aucun rapport apparent avec sa cause.
- Un corps illisible — envoi interrompu, proxy qui tronque — remontait en 500. C'est une
  faute du client : le téléphone n'a qu'à rejouer son lot. Le filtre global le traduit
  désormais en 400, pour ne pas faire sonner la supervision à chaque incident réseau.

## 5. Horodatage suspect

Les règles du dépôt — retour à 18 h, verrouillage à 22 h — reposent sur une heure. Un
téléphone dont l'horloge a été reculée y échapperait, et n'a évidemment aucune raison de le
déclarer lui-même. Le serveur, qui détient l'heure de référence, marque désormais tout
événement daté dans le futur au-delà de la tolérance (`CLOCK_SKEW_TOLERANCE_SECONDS`,
cinq minutes par défaut).

**Marqué, jamais rejeté** : une preuve horodatée de travers reste une preuve, et la refuser
reviendrait à effacer ce qu'on cherche justement à constater. Une alerte à clé de
déduplication accompagne le constat — un téléphone à l'horloge faussée synchronise toutes
les quinze minutes, et quatre-vingt-seize alertes par jour ne se lisent pas.

## 6. Ce qui n'a pas été vérifié

| Élément | Pourquoi |
|---|---|
| **Comportement sur téléphone réel** | Un émulateur x86 n'est pas un ARM sous Android constructeur. Le Keystore matériel, StrongBox, les gestionnaires de batterie et le GPS restent hors de portée. |
| **Détection de root face à un vrai root** | Aucun terminal rooté n'a été testé. Ce qui est vérifié est la politique, pas la collecte. |
| **Coût réel de la compression** | Mesuré sur un lot de test, pas sur une journée de tournée. |
| **Suppression des journaux en release** | Les règles R8 sont en place ; l'absence effective de `Log.d` dans le binaire final n'a pas été inspectée. |
| **`FLAG_SECURE`** | Le drapeau est posé ; l'impossibilité de capturer l'écran n'a pas été constatée. |

## 7. Reste à faire

| Point | Phase |
|---|---|
| Device Owner, Lock Task, restrictions, lanceur persistant | 5 — exige un téléphone |
| FCM (réveil rapide), e-mail/SMS | 7 |
| Épinglage de certificat, avec pin de secours et rotation | 7 |
| Empreinte de signature transmise par le serveur à l'enrôlement | 7 |
| Matrice de terminaux, tests de charge | 8 |
