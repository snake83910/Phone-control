# 11 — Phase 4 : application Android (livrée)

État : **terminée et vérifiée sur la chaîne de compilation**. 40 tests Kotlin passent,
l'APK de debug et l'APK de release (R8) se construisent. Le moteur de règles Kotlin
exécute **exactement les mêmes scénarios** que la suite Jest du serveur, et les empreintes
de badge des deux implémentations sont prouvées identiques.

**Ce qui n'a pas pu être vérifié** : rien n'a été installé sur un téléphone réel. Voir §6.

## 1. Construire et tester

```bash
cd apps/android && ./gradlew :core-rules:test :app:testDebugUnitTest :app:assembleDebug
```

Prérequis, tous deux présents sur ce poste :

| Élément | Version | Note |
|---|---|---|
| JDK | **17** | La JDK 22 installée par ailleurs n'est pas prise en charge par le plugin Android Gradle. `JAVA_HOME` doit pointer sur la 17. |
| SDK Android | API 35 | `local.properties` renseigne `sdk.dir`. |
| Gradle | 8.11 | Fourni par le wrapper. |

L'APK sort dans `app/build/outputs/apk/debug/app-debug.apk` (60 Mo en debug, **26 Mo en
release** après R8 — l'essentiel est le modèle ML Kit embarqué).

## 2. Architecture

```text
apps/android/
├── core-rules/          Module Kotlin PUR — aucune dépendance Android
│   ├── Schedule.kt              règles horaires, fuseaux, jour opérationnel
│   ├── GeofenceRules.kt         décisions métier sur une transition
│   ├── GeofenceEngine.kt        moteur anti-faux-positifs (hystérésis, confirmation)
│   ├── DeviceStateMachine.kt    états et effets du téléphone
│   ├── BarcodeNormalizer.kt     normalisation figée, identique au serveur
│   └── BadgeHmac.kt             format des empreintes + HKDF
│
└── app/                 Application Android
    ├── data/local/      Room : file d'événements, badges hors ligne, config, session
    ├── data/remote/     Retrofit, DTO, rotation des jetons
    ├── security/        Keystore, magasin chiffré
    ├── scanner/         CameraX + ML Kit, CODE_128 uniquement
    ├── location/        service de premier plan, cadence adaptative
    ├── geofence/        passerelle positions -> moteur -> règles
    ├── sync/            file d'événements, moteur de synchronisation, workers
    ├── session/         ouverture/fermeture, bascule hors ligne
    ├── schedule/        alarme de verrouillage local, récepteurs
    ├── kiosk/           constat du Device Owner (application en Phase 5)
    └── ui/              Compose : verrouillage, scanner, session, mise en service
```

**Le découpage en deux modules est structurant, pas cosmétique.** La spécification (§55)
exige que la logique métier soit testable sans l'interface Android. `core-rules` n'a aucune
dépendance Android : sa suite tourne sur la JVM en **une seconde**, sans émulateur, et
peut donc s'exécuter en intégration continue à chaque commit.

## 3. Ce qui rend les deux implémentations cohérentes

C'est le point le plus important de cette phase.

Le moteur de règles existe **deux fois** — TypeScript sur le serveur, Kotlin sur le
téléphone — parce qu'il doit fonctionner hors ligne tout en restant sous l'autorité du
serveur. Deux implémentations d'une même règle finissent toujours par diverger. Trois
dispositifs l'empêchent :

1. **Scénarios partagés.** `packages/state-machine-spec/scenarios/*.json` est exécuté par
   Jest **et** par JUnit. Les règles horaires, les changements d'heure, les fuseaux, la
   classification géométrique et les décisions de dépôt sont vérifiés des deux côtés sur
   les mêmes cas.

2. **Vecteurs cryptographiques.** `badge-hash-vectors.json` fixe des empreintes de
   référence. Le serveur les produit avec Node, le téléphone les recalcule en Kotlin — y
   compris la dérivation HKDF, réimplémentée à la main faute d'API sur la JVM 17. Sans ce
   test, une divergence d'encodage (base64 contre base64url, préfixe de version oublié)
   ne se verrait qu'un soir de panne réseau, sur le terrain.

3. **Normalisation figée.** `BarcodeNormalizer` est le portage exact de
   `normalizeBarcode` côté serveur, avec les mêmes cas de test. Les zéros de tête sont
   conservés des deux côtés.

## 4. Décisions notables

### 4.1 Une seule table d'événements, et non quatre

**Écart assumé par rapport à docs/05 §2.** L'API reçoit positions, transitions, événements
de sécurité et scans dans **un seul tableau ordonné**, et les acquitte en bloc. Avec quatre
tables, chaque cycle devrait fusionner quatre flux triés puis répartir les acquittements :
du code délicat pour un bénéfice nul. La priorité de transmission est exprimée dans la
requête SQL — sécurité, geofence, scans, puis positions. *Une alerte ne doit jamais
attendre derrière quatre mille points GPS.*

### 4.2 Pas de destruction de la base à la migration

`fallbackToDestructiveMigration` est **volontairement absent**. Perdre la file d'événements
non synchronisés lors d'une mise à jour reviendrait à effacer des preuves. Une migration
manquante doit échouer bruyamment.

### 4.3 La transition est datée de la première mesure, pas de la dernière

Le moteur exige trois mesures cohérentes sur deux minutes avant de conclure. L'événement
porte l'horodatage de la **première** : le chauffeur est entré quand il est entré, pas deux
minutes plus tard quand le moteur a fini de se convaincre.

### 4.4 Les signaux complémentaires pondèrent, ils ne décident pas

Wi-Fi du dépôt reconnu, appareil immobile : ces indices **doublent** le nombre de mesures
exigées pour confirmer une sortie. Ils ne la bloquent pas — un blocage laisserait un
téléphone coincé dans un état faux.

### 4.5 Le kiosque constate, il n'impose pas encore

`KioskController.isDeviceOwner` interroge le système ; il ne le suppose jamais. Tant que le
privilège n'est pas attribué, l'écran de verrouillage **affiche** que le mode kiosque n'est
pas actif et que le verrouillage n'est pas garanti. C'est la règle §67 de la spécification :
ne jamais prétendre qu'une fonctionnalité Android fonctionne si elle exige un privilège qui
n'a pas été réellement accordé.

## 5. Défaut trouvé en exécutant les tests

**L'application plantait au démarrage si le magasin sécurisé était illisible.**

Le premier lancement de la suite Robolectric a échoué sur `AndroidKeyStore not found` — dans
`Application.onCreate`, avant même le premier test. Le cas n'est pas théorique : keystore
corrompu après une mise à jour du système, restauration d'image, matériel défaillant. Sur le
terrain, cela donnait un téléphone qui ne démarre plus, sans message.

`SecureStore` tente désormais une reconstruction (suppression des préférences et de la clé,
nouvelle création), puis bascule en **mode dégradé explicite** : l'écran affiche « téléphone
non enrôlé » et il faut le réenrôler. Désagréable, mais diagnosticable et réparable.

## 6. Ce qui n'a pas été vérifié, et pourquoi

Aucun téléphone Android n'a été utilisé. Ce qui suit **compile, se teste, mais n'a pas été
constaté** :

| Élément | Ce qui reste à vérifier sur matériel |
|---|---|
| **Scanner Code 128** | Distance et angle de lecture réels sur un badge imprimé, en cabine, de nuit comme en plein soleil. C'est le point qui décide de l'acceptabilité du produit. |
| **Précision GPS au dépôt** | Les seuils (250 m, 75 m d'hystérésis, 100 m de précision) sont des valeurs par défaut raisonnables, pas des mesures. |
| **Survie du service en tâche de fond** | Les gestionnaires de batterie Samsung, Xiaomi et Oppo tuent régulièrement les services de localisation. Aucune API ne le garantit — seule une matrice de tests par modèle le dira (docs/01 §2.3). |
| **Alarme exacte à 22 h** | Le code demande `setExactAndAllowWhileIdle` et se replie sinon, mais le comportement réel dépend du constructeur. |
| **Mode kiosque** | Non implémenté : Phase 5, et non vérifiable sans Device Owner. |
| ~~**Empreinte Keystore**~~ | **Levé en Phase 6** : vérifié sur émulateur — le calcul par une clé Keystore non exportable donne exactement la même empreinte qu'un calcul direct, et la clé refuse bien de sortir. Voir [docs/13 §2.4](13-phase6-hors-ligne-durcissement.md). |

Ces points sont exactement ceux que la Phase 5 doit lever, avec un téléphone dédié.

## 7. Reste à faire

| Point | Phase |
|---|---|
| Device Owner, Lock Task, restrictions, lanceur persistant | 5 |
| Provisioning par QR code, enrôlement sans saisie | 5 |
| ~~Base locale chiffrée (SQLCipher)~~ | **livré en Phase 6** — voir note ci-dessous |
| ~~Détection root / ADB / débogueur, dérive d'horloge~~ | **livré en Phase 6** |
| FCM (réveil rapide) | 7 |
| Épinglage de certificat | 7 |

> **Note sur le chiffrement de la base.** Au moment de la Phase 4, la base Room était en
> clair, protégée seulement par le bac à sable applicatif d'Android. C'est désormais fait :
> SQLCipher, phrase secrète dans le magasin sécurisé, conversion des bases existantes sans
> perte de la file d'événements. Vérifié sur émulateur —
> [docs/13 §2](13-phase6-hors-ligne-durcissement.md).

## 8. Prochaine étape

**Phase 5 — Device Owner et kiosque.** Elle exige un **téléphone Android réinitialisable**
(Android 9 minimum, `minSdk = 28`). Sans ce matériel, elle ne peut être ni écrite
honnêtement ni validée : tout ce qu'elle produit se vérifie par constat, pas par
compilation.
