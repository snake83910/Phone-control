# Charge utile du QR code de provisioning

Ce paquet existe pour une raison précise : **deux programmes fabriquent le même QR code.**

- `tools/provisioning` — l'outil d'atelier, pour un parc entier, avec planche PDF ;
- `apps/dashboard` — la page « Mise en service », pour un téléphone ou une petite série.

Deux constructions du même format finiraient par diverger, et la divergence ne se verrait
qu'au moment où un téléphone neuf refuse de se configurer, sur un carton de terminaux à
mettre en service. Le format vit donc ici, une seule fois : les clés Android, les règles de
validité, le contrat des extras, le rendu du code.

Ce qui n'y est pas, et reste propre à l'atelier : la lecture d'un APK, la planche PDF, le
fichier de parc, la voie ADB.

## Contenu

| Fichier | Rôle |
|---|---|
| `src/payload.ts` | Construction **et** vérification de la charge utile. |
| `src/profile.ts` | Schéma du profil de provisioning, partagé par le fichier de l'atelier et l'environnement du dashboard. |
| `src/checksum.ts` | Empreinte de signature : SHA-256 du certificat, base64 URL-safe sans remplissage. |
| `src/qr.ts` | Matrice, PNG, SVG, taille d'impression conseillée. |
| `src/redact.ts` | Masquage des jetons. |
| `src/contract/admin-extras.json` | Clés du bundle d'extras — lu aussi par la suite de tests du module Android. |

## Le contrat des extras

`src/contract/admin-extras.json` est lu par trois programmes : les deux qui fabriquent le QR
code, et `ProvisioningContractTest` dans le module Android, qui le **consomme**.

Renommer `enrollmentToken` d'un seul côté ferait échouer tous les enrôlements d'un parc
**sans message d'erreur** : le téléphone se provisionnerait normalement, deviendrait Device
Owner, se connecterait — et resterait non enrôlé. C'est le même dispositif que
`packages/state-machine-spec` pour le moteur de règles.

Le chemin de ce fichier est déclaré comme entrée de la tâche Gradle : le déplacer sans
mettre à jour `apps/android/app/build.gradle.kts` ferait passer le test au vert sans qu'il
s'exécute.

## Tests

```bash
pnpm --filter @phone-control/provisioning-payload test
```

Le plus utile est l'**aller-retour** : le PNG produit est relu par un décodeur indépendant
(`jsQR`) et rend exactement la charge utile encodée, aux quatre niveaux de correction et
jusqu'à trois pixels par module. C'est la seule preuve possible sans téléphone que la
chaîne tient debout.

Ce qu'aucun test ici ne prouve : qu'Android accepte cette charge utile. Cela se constate
sur un terminal réinitialisé.
