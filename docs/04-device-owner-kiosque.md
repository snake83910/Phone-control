# 04 — Stratégie Device Owner, provisioning et mode kiosque

## 1. Décision : DPC propriétaire plutôt qu'Android Management API

Deux voies officielles existent pour gérer un parc Android en mode Device Owner.

| | **DPC propriétaire** (retenu) | Android Management API (Google) |
|---|---|---|
| Contrôle des politiques | Total, via `DevicePolicyManager` | Limité au catalogue de politiques Google |
| Logique métier dans la même app | Oui — scanner, kiosque, geofence, sync dans un seul APK | Non : il faut une seconde application, donc deux cycles de vie |
| Dépendance à Google | Play Services souhaitable, non indispensable | Compte Google entreprise obligatoire, dépendance forte |
| Coût | Développement du DPC | Service géré, mais politiques imposées |
| Kiosque avec écran de verrouillage métier personnalisé | Naturel | Contorsions |

L'application **est** à la fois le DPC, le launcher et l'application métier. C'est la seule
architecture qui permet l'écran « TÉLÉPHONE BLOQUÉ / Présentez votre badge » comme véritable
écran d'accueil du téléphone.

> Si le client dispose déjà d'un contrat Android Enterprise avec un EMM, l'alternative reste
> possible : notre application deviendrait alors une application métier déployée par l'EMM,
> en mode kiosque géré par lui. Le backend et le dashboard sont inchangés. À arbitrer.

## 2. Méthodes de provisioning

### 2.1 QR code (méthode de production recommandée)

Sur un téléphone neuf ou réinitialisé, **six appuis sur l'écran de bienvenue** ouvrent le
lecteur de QR code de provisioning. Le QR encode un JSON :

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
      "com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM":
      "<SHA-256 URL-safe base64 de la signature de l'APK>",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
      "https://<domaine>/provisioning/phonecontrol-1.0.0.apk",
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": false,
  "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
  "android.app.extra.PROVISIONING_WIFI_SSID": "ATELIER-FLOTTE",
  "android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE": "WPA",
  "android.app.extra.PROVISIONING_WIFI_PASSWORD": "...",
  "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
    "enrollmentToken": "ETK-...",
    "serverUrl": "https://api.<domaine>/api/"
  }
}
```

Points d'attention réels :

- le **checksum de signature** est celui de la clé de signature de l'APK, pas celui du
  fichier ; il ne change pas à chaque version, ce qui permet des QR codes durables ;
- l'APK doit être servi en HTTPS sur une URL publiquement joignable depuis le téléphone
  **avant** tout enrôlement ; c'est un endpoint non authentifié, donc versionné et
  contrôlé par checksum ;
- `PROVISIONING_ADMIN_EXTRAS_BUNDLE` transporte le **jeton d'enrôlement** : c'est ce qui
  associe le téléphone à une entreprise et un dépôt sans aucune saisie sur le terminal ;
- le dashboard génère ces QR codes (par lot, un par téléphone ou un par dépôt selon la
  politique) — page `/devices/provisioning`.

### 2.2 ADB (développement et atelier)

```bash
adb shell dpm set-device-owner com.phonecontrol/.kiosk.PhoneControlDeviceAdminReceiver
```

Conditions : appareil sans compte configuré, débogage USB activé, aucun autre profil.
Utilisé pour le développement en Phase 5 et pour le dépannage en atelier.

En pratique, passez par `pcprov adb-owner` : la commande constate ces conditions et les
explique, au lieu de laisser lire un « not allowed » sans contexte. Elle ne les contourne
pas — voir [docs/12 §3.5](12-outillage-provisioning.md).

### 2.3 Zero-touch (grande échelle)

Terminaux achetés auprès d'un revendeur partenaire, inscrits dans la console zero-touch,
configuration poussée dès le premier démarrage sans aucune manipulation. **Prérequis
commercial** : à recommander au client dès qu'il dépasse la centaine de terminaux.

### 2.4 NFC

Provisioning par contact depuis un téléphone « programmeur ». Rapide en atelier, mais le QR
code couvre les mêmes besoins sans matériel dédié. Non retenu en v1.

## 3. Procédure d'enrôlement complète

```text
 1. Le dashboard crée l'appareil : asset_tag, entreprise, dépôt, mode kiosque
        → génère un jeton d'enrôlement à usage unique (TTL 7 jours)
        → affiche/imprime le QR code de provisioning
 2. Factory reset du téléphone
 3. Écran de bienvenue → 6 appuis → lecture du QR code
 4. Le téléphone rejoint le Wi-Fi d'atelier et télécharge l'APK
 5. Android attribue le rôle Device Owner à l'application
 6. onProfileProvisioningComplete() :
        - application des restrictions et politiques (§4)
        - octroi silencieux des permissions (localisation, caméra, notifications)
        - déclaration comme launcher persistant
        - configuration de Lock Task
 7. POST /api/v1/devices/enroll { enrollmentToken, serial, imei, model,
                                  androidVersion, publicKey, deviceOwnerActive }
        ← { deviceId, accessToken, refreshToken, settings, depot, geofences }
 8. Persistance des identifiants dans le Keystore (StrongBox si disponible)
 9. Premier heartbeat + première synchronisation complète
10. Passage à l'état LOCKED : écran « Présentez votre badge »
```

Le téléphone est prêt. Durée réelle attendue : 8 à 12 minutes, dont l'essentiel en
téléchargement et chiffrement.

**Industrialisation — livré**, voir [docs/12](12-outillage-provisioning.md) et
[tools/provisioning/README.md](../tools/provisioning/README.md). L'outil d'atelier prend un
fichier CSV (`asset_tag, serial, depot`), appelle l'API pour créer les appareils et émettre
les jetons, puis produit une planche de QR codes en PDF prête à imprimer et à coller au dos
de chaque téléphone.

Deux points valent d'être retenus de ce qui a été écrit. L'empreinte du QR code est celle du
**certificat de signature**, non du fichier APK : une planche imprimée survit donc aux mises
à jour de l'application. Et la configuration est vérifiée **avant** qu'un seul jeton ne soit
émis, parce qu'un jeton est à usage unique : en produire deux cents avec une empreinte
erronée revient à les jeter.

Restent à faire pour la Phase 5 : l'hébergement HTTPS de l'APK, la page
`/devices/provisioning` du dashboard, et l'enrôlement effectif dans
`onProfileProvisioningComplete`.

## 4. Politiques appliquées par le DPC

### 4.1 Restrictions utilisateur

| Restriction | Effet | Justification |
|---|---|---|
| `DISALLOW_FACTORY_RESET` | Empêche la réinitialisation depuis les paramètres | Protège l'enrôlement |
| `DISALLOW_SAFE_BOOT` | Bloque le mode sans échec | Contournement classique du kiosque |
| `DISALLOW_DEBUGGING_FEATURES` | Désactive ADB et les options développeur | Empêche `pm disable`, `am force-stop` |
| `DISALLOW_CONFIG_DATE_TIME` | Verrouille l'horloge | **Indispensable à la règle des 22h** |
| `DISALLOW_CONFIG_LOCATION` | Empêche de couper la localisation | Exigence de suivi |
| `DISALLOW_ADD_USER` / `DISALLOW_USER_SWITCH` | Pas de profil parallèle | Évasion du kiosque |
| `DISALLOW_INSTALL_UNKNOWN_SOURCES` | Pas d'APK tiers | Sécurité |
| `DISALLOW_UNINSTALL_APPS` | Notre application n'est pas désinstallable | Exigence |
| `DISALLOW_AIRPLANE_MODE` | Limite la coupure réseau volontaire | Réduit les angles morts |
| `DISALLOW_CONFIG_TETHERING`, `DISALLOW_MOUNT_PHYSICAL_MEDIA`, `DISALLOW_USB_FILE_TRANSFER` | Divers | Fuite de données |

Configuration complémentaire : `setAutoTimeEnabled(true)`, `setAutoTimeZoneEnabled(true)`,
`setLocationEnabled(true)`, `setUninstallBlocked(...)`, `setStatusBarDisabled(true)` en
mode kiosque, `setKeyguardDisabled(true)` (l'écran de verrouillage Android est remplacé par
le nôtre), `setMaximumTimeToLock`, désactivation de la capture d'écran si demandé.

### 4.2 Lock Task

```kotlin
dpm.setLockTaskPackages(admin, allowedPackages.toTypedArray())
dpm.setLockTaskFeatures(
    admin,
    LOCK_TASK_FEATURE_HOME or            // notre app est le launcher
    LOCK_TASK_FEATURE_SYSTEM_INFO or     // heure, batterie, réseau visibles
    LOCK_TASK_FEATURE_NOTIFICATIONS      // appels et messages entrants visibles
    // GLOBAL_ACTIONS volontairement absent : masque « Éteindre »
    // KEYGUARD absent : pas de verrouillage Android par-dessus le nôtre
)
```

- **Mode `KIOSK`** : `allowedPackages` = notre application + la liste configurée par
  l'administrateur (Téléphone, Messages, Maps, Chrome, application métier). Notre écran
  d'accueil sert de lanceur.
- **Mode `RESTRICTED`** : launcher système conservé, mais applications masquées via
  `setApplicationHidden`, et écran de verrouillage métier au démarrage et à 22h.
- **Mode `STANDARD`** : politiques minimales, uniquement suivi et règles horaires. Utile
  pour les cadres ou en phase de déploiement progressif.

Le changement de mode est une commande serveur (`SYNC_SETTINGS`) appliquée sans
réinstallation.

### 4.3 Sécurité par conception

- **Accès aux appels d'urgence** : le composeur d'urgence Android reste accessible depuis
  l'écran de verrouillage même en Lock Task. Ne jamais chercher à le bloquer — c'est à la
  fois une obligation et une évidence.
- Un **code de sortie superviseur** (PIN à durée limitée, dérivé côté serveur, vérifiable
  hors ligne) permet à un responsable d'atelier de sortir du kiosque pour maintenance. Chaque
  usage produit un événement `KIOSK_EXIT_ATTEMPT` avec le résultat.

## 5. Résilience du kiosque

| Événement | Réaction |
|---|---|
| Redémarrage | `BOOT_COMPLETED` → notre application est le launcher, elle démarre et restaure l'état persisté (verrouillé ou session valide) |
| Application tuée par le système | `LockTaskMonitorService` (foreground) + `WorkManager` de contrôle toutes les 15 min relancent l'activité kiosque |
| Perte du rôle Device Owner | Événement `DEVICE_OWNER_LOST` + alerte `CRITICAL`, l'application se replie en mode `RESTRICTED` et **le signale explicitement** |
| Crash au démarrage | Compteur de crashs consécutifs ; au-delà de 3, mode dégradé « verrouillé simple » avec remontée de diagnostic |

## 6. Ce que l'application ne fera pas

Aucun contournement des protections Android : pas d'exploitation de faille, pas d'API
constructeur non documentée, pas de service accessibilité détourné pour bloquer l'interface,
pas de superposition d'écran hostile. Toute fonctionnalité de verrouillage repose sur
`DevicePolicyManager` et Lock Task, c'est-à-dire sur les mécanismes prévus par Google pour
ce cas d'usage précis.

**Conséquence à assumer** : sans Device Owner réellement attribué, l'application n'est
qu'une application ordinaire. Le dashboard le montrera sans ambiguïté plutôt que d'afficher
une protection qui n'existe pas.
