# 12 — Outillage de provisioning (livré)

État : **terminé et vérifié par les tests**. 27 tests sur le format partagé, 51 sur
l'outil d'atelier, 4 de parité côté Android. Deux chemins produisent des QR codes de
provisioning Device Owner : l'outil d'atelier, à partir d'un fichier de parc, avec planche
d'étiquettes à imprimer ; et la page « Mise en service » du dashboard, pour un téléphone ou
une petite série.

La chaîne complète — jeton émis par l'API, encodé, relu par un décodeur indépendant,
renvoyé à la route d'enrôlement — a été parcourue contre une API réelle (§6).
**Ce qui n'a pas pu l'être** : aucun téléphone n'a lu un de ces QR codes (§7).

Il s'agit des livrables annoncés en [docs/04 §2.1 et §3](04-device-owner-kiosque.md) —
`tools/provisioning/` et la page `/devices/provisioning` — préparés **avant** la Phase 5
parce qu'ils en sont la part qui se valide sans matériel.

## 1. Ce que c'est

```bash
export PC_ADMIN_PASSWORD='...'
pnpm --filter @phone-control/provisioning build

node dist/cli.js checksum --apk ../../apps/android/app/build/outputs/apk/release/app-release.apk
node dist/cli.js batch --config provisioning.config.json --csv parc.csv --dry-run
node dist/cli.js batch --config provisioning.config.json --csv parc.csv
```

En sortie : une planche PDF à découper, un QR code par téléphone, la charge utile JSON
correspondante, et un manifeste de campagne. Mode d'emploi complet dans
[tools/provisioning/README.md](../tools/provisioning/README.md).

Pour un seul téléphone — remplacement, ajout, dépannage — le dashboard suffit : page
**Flotte → Mise en service**, ou le bouton « QR de provisioning » sur la fiche du
téléphone. Elle sélectionne, émet, affiche les étiquettes et les imprime. Elle reste muette
tant que `PROVISIONING_SERVER_URL` n'est pas renseignée : elle dit alors ce qui manque,
plutôt que de produire un QR code inopérant.

## 2. Architecture

Le format du QR code est **défini une seule fois**, dans un paquet que les deux
producteurs partagent :

```text
packages/provisioning-payload/       ← le format, et rien d'autre
├── src/payload.ts        construction ET vérification du JSON de provisioning
├── src/profile.ts        schéma du profil, commun au fichier et à l'environnement
├── src/checksum.ts       empreinte de signature (base64 URL-safe, sans remplissage)
├── src/qr.ts             matrice, PNG, SVG, taille d'impression conseillée
├── src/redact.ts         masquage des jetons
└── src/contract/admin-extras.json   contrat des extras, lu aussi côté Android

tools/provisioning/                  ← l'atelier : parc entier, planche PDF
├── src/lib/apk-signature.ts   lecture du certificat dans le bloc de signature APK
├── src/lib/config.ts          fichier de configuration, secrets refusés dedans
├── src/lib/csv.ts             fichier de parc, tel qu'un tableur le produit
├── src/lib/api.ts             quatre routes de l'API, écrites à la main
├── src/lib/sheet.ts           planche PDF, QR dessinés en vectoriel
├── src/lib/outputs.ts         écriture des livrables, en accès restreint
├── src/lib/adb.ts             voie ADB : constat des conditions, sans contournement
└── src/commands/              batch, device, checksum, payload, verify, adb-owner

apps/dashboard/                      ← l'unité et la petite série
├── src/lib/server/provisioning.ts   profil lu dans l'environnement
├── src/app/api/provisioning/        émission des jetons, rendu SVG, côté serveur
└── src/app/(app)/devices/provisioning/   sélection, étiquettes, impression
```

**Pourquoi un paquet plutôt qu'une copie.** Deux constructions du même format finissent par
diverger, et la divergence ne se verrait qu'au moment où un téléphone neuf refuse de se
configurer — devant un carton de terminaux à mettre en service. C'est le même raisonnement
que `packages/state-machine-spec` pour le moteur de règles.

Les modules du paquet, ainsi que `csv`, `config`, `adb` et `apk-signature` côté outil, sont
**purs** : aucun accès réseau, aucun état. C'est ce qui permet de les couvrir entièrement
par des tests, alors que la validation définitive — un téléphone qui s'enrôle — demande du
matériel.

## 3. Décisions notables

### 3.1 La configuration est vérifiée avant qu'un seul jeton ne soit émis

`batch` construit une charge utile complète avec un **jeton factice au format réel**, la
soumet à tous les contrôles, et n'appelle l'API que si elle passe.

La raison est économique autant que technique : un jeton d'enrôlement est à usage unique et
expire au bout de sept jours. En émettre deux cents avec une empreinte de signature erronée
revient à les jeter, puis à attendre leur expiration ou à les révoquer un par un dans le
dashboard. La vérification tardive coûterait une demi-journée d'atelier.

### 3.2 L'empreinte est celle du certificat, pas celle du fichier

`PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` porte le SHA-256 du **certificat de
signature**, en base64 URL-safe **sans remplissage**. Une planche imprimée reste donc
valable quand l'application est mise à jour : la clé de signature ne change pas.

L'outil lit ce certificat directement dans le bloc de signature de l'APK — schémas v2, v3 et
v3.1, dont les longueurs sont préfixées en entiers 32 bits, sans ASN.1 à traverser. Aucune
dépendance au SDK Android : un atelier n'a pas forcément `apksigner` installé, et une
empreinte fausse produit un échec dont le message ne désigne rien
(« Impossible de configurer l'appareil »).

Un APK signé uniquement en schéma v1 (JAR) est refusé, avec la commande `apksigner` exacte
à lancer pour extraire le certificat. Écrire un second analyseur ASN.1 pour un format que
le module Android n'utilise pas aurait été du code non exercé.

### 3.3 Les valeurs du bundle d'extras sont des chaînes, et c'est vérifié

Android convertit `PROVISIONING_ADMIN_EXTRAS_BUNDLE` en `PersistableBundle` : un entier ou
un objet imbriqué y disparaît **silencieusement**. Le validateur refuse toute valeur qui
n'est pas une chaîne, plutôt que de laisser découvrir la perte sur le terrain.

### 3.4 La planche dessine les QR en vectoriel

Chaque module est un rectangle, pas un pixel. Une image PNG mise à l'échelle par une
imprimante perd ses bords ; sur un code de version 24 — 113 modules de côté pour une charge
utile typique de 900 octets — c'est la différence entre un scan immédiat et cinq minutes
d'énervement devant un téléphone neuf.

L'outil calcule la taille d'impression minimale à partir du nombre de modules (0,4 mm par
module, jamais moins de 30 mm) et l'affiche.

### 3.5 Rien n'est contourné

`adb-owner` constate les conditions posées par Android — aucun compte configuré, aucun
propriétaire déjà attribué, application installée — et les explique en français. Il ne
remet pas `device_provisioned` à zéro et n'utilise aucune astuce comparable.

Ces conditions protègent un téléphone en service contre une prise de contrôle. Les
contourner ferait fonctionner la commande, et laisserait un parc dans un état qu'aucune
procédure officielle ne sait reproduire — [spécification §67](00-synthese.md).

### 3.6 Le dashboard n'écrit pas de fichier

La page « Mise en service » rend les QR codes en **SVG**, et l'impression est celle du
navigateur. Pas de PDF côté web : le rendu vectoriel du navigateur est déjà net, et un
générateur de PDF dans le serveur Next aurait ajouté une dépendance pour dupliquer une
fonction que le système d'impression assure mieux. La taille d'impression n'est pas figée
dans la feuille de style — elle est calculée depuis la densité réelle du code et transmise
avec chaque étiquette.

**Le jeton en clair ne revient jamais comme donnée JSON.** Il est encodé dans les modules
du SVG, ce qui est le but, et masqué partout ailleurs — y compris dans la réponse de la
route. Une capture de l'onglet réseau ne le laisse pas lire ; c'est vérifié.

Le profil du dashboard vient de l'environnement, pas de la base. Ce qu'il décrit relève du
**déploiement** — un même APK, une même clé de signature, un même serveur — tandis que ce
qui rattache un téléphone à une entreprise est le jeton, émis et vérifié par l'API. Un
Wi-Fi d'atelier par entreprise supposerait de stocker le profil en base : ce n'est pas
fait, et c'est signalé au §8.

## 4. Parité avec le module Android

`src/contract/admin-extras.json` déclare les clés transportées par le bundle d'extras. Le
même fichier contraint les deux côtés :

- l'outil qui **fabrique** le QR code (`test/payload.spec.ts`) ;
- le récepteur qui le **consomme** (`ProvisioningContractTest`, module `app`).

Sans ce dispositif, renommer `enrollmentToken` d'un seul côté ferait échouer tous les
enrôlements du parc **sans message d'erreur** : le téléphone se provisionnerait normalement,
deviendrait Device Owner, se connecterait — et resterait non enrôlé. C'est le même principe
que `packages/state-machine-spec` pour le moteur de règles.

## 5. Défaut trouvé en testant le test

Le test de parité Kotlin passait. Pour vérifier qu'il **échouait** quand le contrat diverge,
j'ai renommé une clé dans le JSON et relancé Gradle :

```text
> Task :app:testDebugUnitTest UP-TO-DATE
BUILD SUCCESSFUL
```

Le contrat vit hors du projet Gradle, qui ne le connaissait donc pas comme entrée de la
tâche. Le test n'était pas rejoué : **le garde-fou avait exactement le défaut qu'il était
censé empêcher.**

Le même problème existait depuis la Phase 4 sur `packages/state-machine-spec/scenarios` —
modifier un scénario partagé laissait `:core-rules:test` en `UP-TO-DATE`. Les deux fichiers
de build déclarent désormais ces chemins par `inputs.file(...)` et `inputs.dir(...)`. Après
correction, la mutation du contrat fait bien échouer trois tests sur quatre.

## 6. Ce qui a été vérifié de bout en bout

Un test facultatif — il écrit dans la base, donc il ne s'exécute que sur demande et jamais
en intégration continue — fait parcourir au jeton la chaîne complète :

```text
API  ──émission──▶  charge utile  ──▶  PNG  ──▶  décodeur QR indépendant
                                                          │
                            POST /v1/devices/enroll  ◀─────┘
                                     ▼
              200 · jetons d'appareil, dépôt, clé HMAC hors ligne
                                     │
                       rejeu du même jeton ──▶ 401
```

Exécuté le 2026-09-05 contre l'API locale : le téléphone est ressorti enrôlé, rattaché à son
dépôt, avec sa clé hors ligne ; le rejeu du jeton a bien été refusé. Deux fiches de
vérification (`TEL-PROV-01`, `E2E-…`) ont été créées puis révoquées dans la base de
démonstration ; un `pnpm db:seed` les efface.

C'est la vérification la plus forte possible **sans téléphone**. Elle ne dit rien de ce qui
suit.

La route du dashboard a été exercée séparément contre la même API : jetons émis, étiquettes
rendues, avertissements remontés (mot de passe Wi-Fi en clair, API en `http://`), et
**aucun jeton lisible dans le corps de la réponse** — vérifié par expression régulière sur
le JSON complet et sur le texte du SVG. La page elle-même n'a pas été parcourue dans un
navigateur : cela demandait de saisir un mot de passe, ce que je ne fais pas. Son rendu
d'étiquette a été contrôlé sur un aperçu statique construit à partir d'une vraie réponse.

## 7. Ce qui n'a pas été vérifié, et pourquoi

| Élément | Ce qui reste à constater sur matériel |
|---|---|
| **Lecture par Android** | Aucun téléphone n'a lu un de ces QR codes. Le format suit la documentation Android et se relit par un décodeur indépendant, mais l'acceptation par `ManagedProvisioning` ne se prouve que sur un terminal réinitialisé. |
| **Impression** | La taille conseillée (0,4 mm par module) est une règle d'usage, pas une mesure. À valider sur l'imprimante de l'atelier, avec le papier de l'atelier. |
| **Téléchargement de l'APK** | L'URL doit être joignable en HTTPS depuis le Wi-Fi d'atelier **avant** tout enrôlement. Cet hébergement n'existe pas encore. |
| **Voie ADB** | Les analyseurs de sortie sont testés sur des sorties `adb` réelles recopiées, jamais sur un terminal branché. |
| **Page du dashboard** | Le gestionnaire de route est vérifié ; la page n'a pas été utilisée dans un navigateur connecté. Sélection, impression et mise en page restent à parcourir. |
| **Durée réelle** | Les 8 à 12 minutes annoncées en [docs/04 §3](04-device-owner-kiosque.md) restent une estimation. |

## 8. Reste à faire

| Point | Phase |
|---|---|
| Hébergement HTTPS de l'APK, versionné et contrôlé par checksum | 5 |
| Profil de provisioning par entreprise (Wi-Fi d'atelier propre à chacune) | 5 ou 6 |
| `onProfileProvisioningComplete` : enrôlement réel à partir du jeton du bundle | 5 |
| Politiques du DPC, Lock Task, lanceur persistant | 5 |
| Code de sortie superviseur (docs/04 §4.3) | 5 |

## 9. Prochaine étape

**Phase 5 — Device Owner et kiosque.** Cet outillage en couvre la partie qui se vérifie
sans matériel. Le reste — attribution effective du rôle, application des restrictions,
survie du kiosque au redémarrage — exige un **téléphone Android réinitialisable**
(Android 9 minimum, `minSdk = 28`), et se constate plutôt qu'il ne se compile.
