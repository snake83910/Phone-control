# 21 — Dossier d'inscription du DPC auprès de Google

À déposer **avant** toute mise en service de téléphones. Sans cette inscription,
Play Protect bloque le provisionnement avec « Application dangereuse bloquée »,
et l'enrôlement Device Owner échoue (docs/18 §3).

Le délai de réponse va de quelques jours à plusieurs mois, sans engagement de
Google. C'est le chemin critique du projet.

## 1. Avant de déposer : cinq choses à vérifier

Le dossier ne peut pas être envoyé tant que ces cinq points ne sont pas réglés.
Quatre sont de simples relevés ; le premier demande une décision.

| # | À faire | Où |
|---|---|---|
| 1 | Créer la clé de signature de production et la conserver hors du dépôt | voir §2 |
| 2 | Relever l'empreinte du certificat de signature | `pcprov checksum` |
| 3 | Renseigner la raison sociale et le pays de l'éditeur | §3 |
| 4 | Renseigner l'adresse publique de la politique de confidentialité | §3 |
| 5 | Relire §5 et confirmer que chaque affirmation est vraie | §5 |

Une affirmation inexacte dans ce dossier ne se traduit pas par un refus poli :
elle disqualifie les demandes suivantes.

## 2. La clé de signature de production

Elle n'existe pas encore : les APK construits jusqu'ici portent la clé de débogage
d'Android (`CN=Android Debug`), qui n'est acceptable ni pour une inscription, ni
pour une flotte.

```bash
keytool -genkeypair -v \
  -keystore phone-control-release.jks \
  -alias phone-control \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -dname "CN=<raison sociale>, O=<raison sociale>, C=FR"
```

Trois conséquences à mesurer avant de taper la commande :

- **Cette clé ne se remplace pas.** Android refuse de mettre à jour une
  application par une version signée d'une autre clé. La perdre signifie
  désinstaller puis réinstaller sur chaque téléphone du parc, à la main.
- Elle se sauvegarde comme les secrets serveur (docs/20 §4.1) : hors du dépôt,
  hors du VPS, dans un coffre.
- L'empreinte du certificat entre dans le QR code de mise en service. La changer
  invalide toutes les planches déjà imprimées.

Puis relever l'empreinte à déclarer :

```bash
pnpm --filter @phone-control/provisioning exec pcprov checksum \
  --apk apps/android/app/build/outputs/apk/release/app-release.apk
```

## 3. Identité à déclarer

| Champ | Valeur |
|---|---|
| Nom de l'application | Phone Control |
| Nom de paquet | `com.phonecontrol` |
| Empreinte SHA-256 du certificat | *(§2 — à relever)* |
| Version | 1.0.0 (`versionCode` 1) |
| SDK minimal / cible | 28 / 35 |
| Éditeur | *(raison sociale, pays)* |
| Mode de distribution | **hors Play Store** — provisionnement par QR code d'atelier, parc privé |
| Politique de confidentialité | *(adresse publique — obligatoire)* |
| Contact | *(adresse de l'exploitation)* |

## 4. Le texte à soumettre

Le formulaire de Google est en anglais. Ce qui suit est prêt à coller ; les
`<…>` sont à compléter.

> **Business use case**
>
> Phone Control is an in-house device policy controller for a road transport
> company operating a private fleet of company-owned Android phones. It is not
> sold, not published on Google Play, and not installed on any device outside
> the organisation that owns them.
>
> Each phone is shared between drivers across shifts. The app locks the device
> until a driver identifies themselves by scanning the Code 128 badge they
> already carry, opens a work session, and locks the device again at the end of
> the working day. Its purpose is to make a shared work tool usable and
> accountable, not to observe people.
>
> **Deployment**
>
> Devices are provisioned as fully managed (Device Owner) using a QR code
> produced by our own workshop tooling, on phones the company owns. There is no
> consumer distribution channel and no end-user installation path.
>
> **Compliance with the Mobile Unwanted Software policy**
>
> - *Not a device financing or locking solution.* The app has no capability to
>   lock a device for non-payment. Locking is tied to work sessions only.
> - *Not a surveillance tool.* Location tracking exists **only while a work
>   session is open** — that is, only during paid working time. Outside a
>   session the location service does not run at all. A permanent Android
>   foreground-service notification is shown for the entire duration of any
>   tracking, so the driver cannot be tracked without seeing it.
> - *No silent capture of personal data.* Optional screen sharing for remote
>   assistance requires the driver to accept an in-app request that names the
>   requester and states the reason, and then to confirm Android's own
>   MediaProjection dialog. The session ends automatically after a configured
>   maximum duration, and the driver can stop it at any time from a persistent
>   banner or from the notification. No screen image is ever stored.
> - *No installation without informed consent.* App installation is limited to
>   business applications pushed by the company IT administrator to
>   company-owned devices, with the file's SHA-256 and signing certificate
>   verified on the device before installing.
> - *Transparency by design.* The app never claims a protection it does not
>   have: when the Device Owner privilege is absent, the lock screen and the
>   administration dashboard both state explicitly that kiosk mode is not
>   enforced.
>
> **Sensitive permissions**
>
> - `ACCESS_BACKGROUND_LOCATION` — vehicle and asset location during an open
>   work session, through a typed foreground service with a persistent
>   notification. Never requested or used outside a session.
> - `QUERY_ALL_PACKAGES` — enumerating installed applications is required to
>   apply the fleet application policy (hiding non-work applications on
>   company-owned devices), an enterprise device-management function. It is used
>   in exactly one code path, which does not run unless the app is Device Owner.
>   Root-detection package checks were moved to an explicit `<queries>`
>   declaration so they do not rely on this permission.
>
> The app declares **no** SMS, contacts, call log, microphone, accessibility
> service, overlay or usage-stats permission.

## 5. Ce que ce dossier affirme, et pourquoi c'est vrai

Chaque affirmation ci-dessus correspond à une décision de conception, prise
avant que cette inscription ne soit un sujet. C'est ce qui rend le dossier
défendable : il décrit le produit, il ne l'habille pas.

| Affirmation | Ce qui l'établit |
|---|---|
| Le suivi n'existe que pendant une session | `LocationTrackingService` démarre avec la session et s'arrête avec elle (docs/01 §2.3). Aucun autre appelant. |
| Le chauffeur voit qu'il est suivi | Service de premier plan typé `location`, notification permanente imposée par Android et assumée. |
| Le partage d'écran exige un accord | Machine à états testée des deux côtés, 23 tests bout en bout : aucune image acceptée hors de l'état `ACCEPTED` (docs/17). |
| Aucune image d'écran n'est conservée | Relais temps réel vers le seul administrateur demandeur, jamais d'écriture. Vérifié par un test qui inspecte la base après transmission. |
| Le partage s'arrête seul | Échéance vérifiée côté serveur **et** côté téléphone, pour qu'un appareil hors réseau cesse de lui-même. |
| Les installations sont vérifiées | Empreinte du fichier et du certificat contrôlées sur le téléphone avant installation (docs/19). |
| Aucune protection n'est simulée | Règle §67 du cahier des charges, appliquée jusque dans l'interface : « Device Owner non confirmé » s'affiche tant que le privilège n'est pas réellement accordé. |
| Permissions minimales | Aucune des permissions les plus scrutées n'est déclarée. Liste complète en §6. |

## 6. Permissions déclarées, au complet

Dix-sept, dont deux à justifier. Les autres sont mécaniques.

| Permission | Rôle |
|---|---|
| `CAMERA` | Lecture du Code 128 du badge. Utilisée sur le seul écran de scan. |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Position pendant une session. |
| **`ACCESS_BACKGROUND_LOCATION`** | *À justifier — voir §4.* |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` | Exigées par Android 14 pour le suivi en tâche de fond. |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` | Partage d'écran accepté par le chauffeur. |
| `POST_NOTIFICATIONS` | Notifications imposées par les deux services ci-dessus. |
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | Synchronisation ; l'état du réseau conditionne le mode hors ligne. |
| `RECEIVE_BOOT_COMPLETED` | Reprise du verrouillage après un redémarrage. |
| `WAKE_LOCK` | Remontée des événements en veille. |
| `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM` | Verrouillage à l'heure fixée par le dépôt. |
| **`QUERY_ALL_PACKAGES`** | *À justifier — voir §4.* |
| `BIND_DEVICE_ADMIN` | Récepteur d'administration, désigné par le QR code. |

Permissions **absentes**, et c'est le point le plus fort du dossier :
`READ_SMS`, `RECEIVE_SMS`, `BIND_ACCESSIBILITY_SERVICE`, `SYSTEM_ALERT_WINDOW`,
`READ_CONTACTS`, `READ_CALL_LOG`, `RECORD_AUDIO`, `READ_PHONE_STATE`,
`PACKAGE_USAGE_STATS`.

## 7. Ce qui sera demandé en plus

Google demande une politique de confidentialité **publiquement accessible**. Elle
n'existe pas encore et n'est pas un document technique : elle doit dire quelles
données sont collectées, pendant combien de temps, et par qui elles sont
consultées. Les éléments factuels sont dans docs/07 et dans les durées de
conservation configurées.

C'est aussi le document qu'il faudra présenter aux représentants du personnel
(docs/15 §4). Autant l'écrire une fois.

## 8. Après le dépôt

| Réponse | Suite |
|---|---|
| Acceptée | La Phase 5 peut démarrer : provisionnement Device Owner sur un téléphone réel. |
| Refusée avec motif | Corriger, puis redéposer. Des développeurs rapportent plusieurs allers-retours. |
| Sans réponse | Relancer. Il n'existe pas d'engagement de délai. |

En attendant, tout le reste du projet avance : le serveur se déploie (docs/20),
le tableau de bord fonctionne, et l'application se construit. Seul
l'enrôlement en mode kiosque est suspendu à cette réponse.

## 9. Sources

- [Approved Android Enterprise device policy controllers allowlist](https://support.google.com/work/android/answer/16694822)
- [Google Play Protect is now the custom DPC gatekeeper — Jason Bayton](https://bayton.org/blog/2025/12/the-dpc-allowlist/)
- [Play Protect blocked my DPC, why? — Jason Bayton](https://bayton.org/android/android-enterprise-faq/play-protect-blocked-my-dpc-why/)
