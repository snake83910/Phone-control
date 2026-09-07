# pcprov — outillage d'atelier

Transforme une liste de téléphones en **étiquettes à coller**, chacune portant un QR code
qui provisionne le terminal et l'enrôle dans l'entreprise sans aucune saisie sur l'écran.

> **Ce que cet outil ne fait pas.** Il fabrique et vérifie des QR codes de provisioning.
> Il n'a jamais provisionné un téléphone : cela demande du matériel, et c'est l'objet de la
> Phase 5. Ce qui est vérifié ici l'est par des tests — voir « Ce qui est prouvé » plus bas.

## En trente secondes

```bash
export PC_ADMIN_PASSWORD='...'          # jamais dans un fichier versionné
pnpm --filter @phone-control/provisioning build

node dist/cli.js checksum --apk ../../apps/android/app/build/outputs/apk/release/app-release.apk
# → colle l'empreinte dans provisioning.config.json

node dist/cli.js batch --config provisioning.config.json --csv parc.csv --dry-run
node dist/cli.js batch --config provisioning.config.json --csv parc.csv
```

Sortie : `out/planche-<date>.pdf` (à imprimer), `out/qr/*.png`, `out/payload/*.json`,
`out/manifeste.csv`.

## Les commandes

| Commande | Ce qu'elle fait | Réseau |
|---|---|---|
| `batch` | Parc complet : crée les fiches, émet les jetons, produit QR codes, planche et manifeste. | oui |
| `device` | Un seul téléphone : remplacement, dépannage, ajout. | oui |
| `checksum` | Empreinte de signature à partir de l'APK ou d'un certificat. | non |
| `payload` | Fabrique et vérifie une charge utile à partir d'un jeton déjà émis. | non |
| `verify` | Contrôle une charge utile existante, avant réimpression. | non |
| `adb-owner` | Voie ADB pour le développement (docs/04 §2.2). | non |

`--dry-run` sur `batch` montre le plan complet sans rien créer ni émettre.

## Configuration

Copiez `provisioning.config.example.json`, adaptez, passez-le par `--config`.

**Aucun mot de passe n'a le droit d'y figurer** — le schéma les refuse nommément et indique
la variable à utiliser. La configuration décrit un parc et se versionne ; les secrets
arrivent par l'environnement (spécification §51, « Aucun secret dans Git ») :

| Variable | Usage |
|---|---|
| `PC_ADMIN_PASSWORD` | mot de passe de l'administrateur du dashboard |
| `PC_WIFI_PASSWORD` | clé du Wi-Fi d'atelier, encodée dans le QR code |
| `PC_API_URL`, `PC_ADMIN_EMAIL`, `PC_SERVER_URL`, `PC_SIGNATURE_CHECKSUM`, `PC_APK_URL` | surcharges, pour basculer de recette en production sans dupliquer le fichier |

`--env-file mon.env` charge ces variables depuis un fichier ; `.env*` est déjà ignoré par Git.

Le schéma est **strict** : une clé inconnue est une erreur. Une faute de frappe sur
`signatureChecksum` produirait sinon un QR code sans empreinte, refusé par le téléphone
après plusieurs minutes de provisioning, sans rien qui désigne la cause.

## Le fichier de parc

Il vient d'un tableur, et le plus souvent d'un tableur français. Sont acceptés : le
point-virgule comme le virgule ou la tabulation, la marque d'ordre d'octets, les accents
dans les en-têtes, les guillemets, les retours chariot Windows.

```csv
asset_tag;serial;depot;kiosk_mode
TEL-001;R58N70ABCDE;Lyon Est;KIOSK
TEL-002;;Marseille Nord;RESTRICTED
```

Seule la colonne d'étiquette est obligatoire (`asset_tag`, `assetTag`, `etiquette`,
`identifiant` ou `telephone`). Le dépôt est résolu par son **nom**, accents et casse
indifférents ; un nom inconnu ou ambigu arrête la campagne en nommant la ligne fautive.

## Trois décisions qui méritent d'être dites

### La configuration est vérifiée avant qu'un seul jeton ne soit émis

`batch` valide une charge utile complète avec un jeton factice **avant** d'appeler l'API.
Un jeton est à usage unique et daté : en produire deux cents avec une empreinte erronée
revient à les jeter, puis à attendre leur expiration ou à les révoquer un par un.

### L'empreinte calculée est celle du certificat, pas celle du fichier

`PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` porte le SHA-256 du **certificat de
signature**, en base64 URL-safe sans remplissage. C'est ce qui permet à une planche imprimée
de rester valable quand l'application est mise à jour : la clé de signature ne change pas.

L'empreinte du fichier APK existe aussi côté Android, mais elle obligerait à réimprimer
toutes les étiquettes à chaque version.

`checksum` lit le certificat directement dans le bloc de signature de l'APK (schémas v2,
v3, v3.1), sans dépendre du SDK Android. Un APK signé uniquement en v1 est refusé avec la
commande `apksigner` exacte à lancer.

> **Piège des builds de debug.** Le module Android applique `applicationIdSuffix = ".debug"`.
> Le paquet devient `com.phonecontrol.debug` alors que la classe du récepteur reste
> `com.phonecontrol.kiosk.PhoneControlDeviceAdminReceiver` : la forme abrégée
> `com.phonecontrol.debug/.kiosk.…` désigne alors une classe qui n'existe pas. Pour un APK
> de debug, écrivez le nom de classe complet. L'outil refuse un composant dont le paquet ne
> correspond pas à `packageName`.

### Rien n'est contourné

`adb-owner` vérifie les conditions d'Android — aucun compte, aucun propriétaire, application
installée — et les explique. Il ne remet pas `device_provisioned` à zéro, ni aucune
astuce du même genre : la commande fonctionnerait, et laisserait un parc dans un état
qu'aucune procédure officielle ne sait reproduire (spécification §67).

## Les jetons sont des secrets

Chaque QR code contient un jeton d'enrôlement : quiconque le lit peut enrôler un téléphone
dans l'entreprise, tant qu'il n'a pas été consommé. Le mot de passe du Wi-Fi d'atelier y
voyage aussi, en clair — c'est inévitable, Android le lit là.

En conséquence :

- le répertoire de sortie **pose son propre `.gitignore`** en arrivant, et `.gitignore`
  racine l'exclut déjà ;
- les fichiers sont créés en accès restreint (`0600`) là où le système le permet ;
- le **manifeste** et les journaux ne contiennent que des jetons masqués — `ETK-••••••••-••••6789` ;
- l'**étiquette imprimée** ne montre pas le jeton en toutes lettres, seulement ses quatre
  derniers caractères, qui suffisent au rapprochement ;
- utilisez un réseau Wi-Fi **dédié au provisioning**, isolé, dont vous changez la clé après
  chaque campagne ;
- imprimez la planche, puis effacez le répertoire de sortie.

## Ce qui est prouvé, et ce qui ne l'est pas

```bash
pnpm --filter @phone-control/provisioning test
```

51 tests ici, 27 dans `packages/provisioning-payload`, plus un test de bout en bout qui
ne s'exécute que sur demande. Les plus utiles :

| Test | Ce qu'il établit |
|---|---|
| **Aller-retour du QR code** | Le PNG produit est relu par un décodeur indépendant (`jsQR`) et rend **exactement** la charge utile encodée, aux quatre niveaux de correction et jusqu'à 3 pixels par module. *(paquet partagé)* |
| **Empreinte de signature** | Le certificat extrait de l'APK donne l'empreinte que `apksigner verify --print-certs` annonce. La valeur de référence vient de l'outil officiel, pas de ce code. |
| **QR vectoriel de la planche** | Le PDF trace exactement un rectangle par module sombre : un code inversé, vide ou tronqué se verrait. |
| **Contrat des extras** | Les clés du bundle sont les mêmes des deux côtés — vérifié dans le paquet partagé **et** par `ProvisioningContractTest` dans le module Android. |
| **Aucun jeton en clair** | Le manifeste et le PDF ne contiennent pas le corps du jeton. |

### Le test de bout en bout

Il écrit dans la base — il crée un téléphone et consomme un jeton — donc il ne s'exécute
que si on le demande, et jamais en intégration continue :

```bash
PC_E2E_API_URL=http://localhost:3001/api PC_E2E_ADMIN_EMAIL=exploitation@transports-demo.local PC_E2E_ADMIN_PASSWORD='...' pnpm --filter @phone-control/provisioning test enrollment-e2e
```

Le jeton émis par l'API traverse la charge utile, l'image PNG, un décodeur QR indépendant,
puis revient à l'API par `POST /v1/devices/enroll` — qui répond 200 avec les jetons de
l'appareil, son dépôt et sa clé hors ligne. Le rejeu du même jeton est ensuite refusé (401),
comme il doit l'être.

C'est la vérification la plus forte possible sans téléphone.

**Ce qu'aucun de ces tests ne prouve** : qu'Android accepte cette charge utile, qu'une
imprimante rende le code lisible, qu'une caméra de terminal neuf le déchiffre à 20 cm sous
un néon d'atelier. Cela se constate sur matériel, et c'est la Phase 5.

## Le format du QR code n'est pas ici

Il vit dans `packages/provisioning-payload`, parce que **deux programmes le fabriquent** :
cet outil, pour un parc entier, et la page « Mise en service » du dashboard, pour un
téléphone ou une petite série. Construction, vérification, rendu et contrat des extras y
sont définis une seule fois.

Ce paquet est aussi lu par `ProvisioningContractTest`, dans le module Android, qui
**consomme** le bundle d'extras. Renommer une clé d'un seul côté ferait échouer tous les
enrôlements du parc sans message utile : le téléphone se provisionnerait normalement,
deviendrait Device Owner, puis resterait non enrôlé. C'est le même dispositif que
`packages/state-machine-spec` pour le moteur de règles.

## Dashboard ou atelier ?

| | Dashboard, page « Mise en service » | `pcprov` |
|---|---|---|
| Volume | l'unité, la petite série (60 max) | un parc entier |
| Sortie | étiquettes à l'écran, impression par le navigateur | planche PDF, QR en PNG, manifeste |
| Entrée | sélection à la souris | fichier de parc CSV |
| Empreinte de signature | lue dans l'environnement du dashboard | calculée depuis l'APK |

Les deux émettent les mêmes jetons et produisent le même format.
