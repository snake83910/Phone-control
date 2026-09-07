# 18 — Installer des applications, et la question du Play Store

Trois réponses, dont une qui n'était pas dans la question et qui compte plus que
les deux autres.

| Question | Réponse |
|---|---|
| Installer une application depuis un APK ? | **Oui**, et sans rien demander au chauffeur. Reste à l'écrire. |
| Intégrer le Google Play Store ? | **Non**, plus possible pour cette architecture. Google a fermé la porte en 2025. |
| *(non demandé)* La mise en service Device Owner va-t-elle seulement fonctionner ? | **À vérifier d'urgence.** Google filtre désormais les DPC à l'enrôlement. |

## 1. Installation depuis un APK — faisable

Un Device Owner installe, met à jour et désinstalle des applications
**silencieusement**, via `PackageInstaller`. Aucune boîte de dialogue, aucune
option « sources inconnues » à activer, aucun geste du chauffeur.

Cela couvre trois besoins :

- déployer une application métier sur toute la flotte ;
- **mettre à jour Phone Control lui-même** à distance, ce qui vaut mieux que de
  faire revenir deux mille téléphones ;
- interdire au chauffeur d'installer quoi que ce soit
  (`DISALLOW_INSTALL_UNKNOWN_SOURCES`).

### 1.1 Ce que cette fonction est, en réalité

Une commande « installe l'APK qui se trouve à cette adresse » est **une
exécution de code arbitraire sur toute la flotte**. C'est la fonction la plus
puissante de tout le système, et de loin la plus dangereuse : quiconque
détournerait cette commande contrôlerait deux mille téléphones.

Elle ne sera donc pas écrite comme un simple téléchargement. Trois verrous, tous
indispensables :

1. **Empreinte SHA-256 de l'APK dans la commande**, vérifiée avant installation.
   Un fichier substitué en chemin est refusé.
2. **Certificat de signature vérifié** avant installation, contre une valeur
   attendue. Le projet sait déjà le faire : `signatureChecksum` dans
   `packages/provisioning-payload` lit le bloc de signature d'un APK, et sert
   déjà aux QR codes de mise en service.
3. **Journal d'audit** : qui a poussé quoi, sur quels téléphones, quand.

Sans le point 2, une empreinte compromise en base suffirait. Avec, il faudrait
en plus voler une clé de signature.

### 1.2 Limites à connaître

| Limite | Conséquence |
|---|---|
| Device Owner obligatoire | Comme tout le reste : Phase 5. |
| Mise à jour = même clé de signature | Une application signée par un tiers ne peut pas être mise à jour par nous. |
| Android 14 refuse les APK visant un SDK trop ancien | Une vieille application métier peut être tout simplement ininstallable. |
| L'APK doit être hébergé quelque part | Un point de plus à sécuriser, et à rendre disponible depuis le réseau mobile. |

## 2. Google Play Store — la porte s'est fermée en 2025

### 2.1 Ce qui a changé

Le Play Store géré (*managed Google Play*) passe par la **Play EMM API**. Or :

- **Google n'accepte plus de nouvelles inscriptions** à la Play EMM API pour les
  DPC maison. Les solutions existantes déjà validées continuent d'être
  supportées ; les nouvelles, non.
- Plusieurs méthodes de cette API utilisées par les DPC maison ont été
  dépréciées en septembre 2021 et **éteintes le 30 septembre 2025**.
- La voie recommandée — en pratique la seule — pour toute nouvelle solution est
  l'**Android Management API** (AMAPI), qui fournit son propre DPC : *Android
  Device Policy*, écrit par Google.

Autrement dit : on ne greffe pas un Play Store géré sur le DPC de ce projet. Ce
n'est pas une difficulté technique, c'est une porte fermée.

### 2.2 Les deux architectures possibles

| | **A — Rester en DPC maison** *(actuel)* | **B — Passer à l'Android Management API** |
|---|---|---|
| Play Store géré | non | **oui** |
| Distribution d'applications | nos APK, notre hébergement (§1) | Play géré + applications privées |
| Logique kiosque et badge | notre code, entièrement | une *policy* Google + notre application métier |
| Allowlist DPC (§3) | **problème à résoudre** | sans objet : le DPC est celui de Google |
| Travail Phases 4-5 | conservé | en grande partie à refaire |
| Dépendance à Google | faible | structurante |

AMAPI sait faire du kiosque (`kioskCustomLauncherEnabled`) et sait installer des
applications personnalisées, via le SDK AMAPI et une *extensibility app*. Ce
n'est donc pas un renoncement fonctionnel — c'est un changement de qui écrit la
politique.

**La question à trancher n'est pas technique.** Elle est : voulez-vous un
Play Store sur ces téléphones ? Sur un parc en mode kiosque, où le chauffeur
n'ouvre qu'une liste d'applications autorisées, un magasin d'applications n'a
souvent aucun usage. S'il n'en a pas, l'option A reste préférable de loin.

## 3. Le point qui n'était pas dans la question

**Depuis 2025, Google Play Protect n'autorise que des DPC approuvés à
s'installer lors du provisionnement d'un appareil d'entreprise.**

La documentation officielle est explicite : « Seuls les DPC validés et approuvés
par Android Enterprise sont autorisés à installer des applications lors du
provisionnement de l'enregistrement des appareils de l'entreprise. » Un DPC
absent de la liste déclenche un **« Application dangereuse bloquée »**, et
l'enrôlement échoue.

Notre DPC n'est pas sur cette liste. Cela concerne directement l'outillage de
mise en service construit en docs/12 : les QR codes d'atelier.

### 3.1 Ce qu'il faut faire, et vite

Le délai de réponse de Google va « de quelques jours à plusieurs semaines », sans
engagement. Des développeurs rapportent plusieurs mois et des appels répétés. **La
demande doit partir maintenant**, en parallèle du reste, et non au moment de
déployer.

### 3.2 Le dossier est en bonne position

Les critères de Google portent sur la conformité aux règles sur les logiciels
indésirables. Sont explicitement rejetés : les verrous de financement
d'appareil, les outils **exclusivement** de surveillance, et l'installation
automatique sans consentement explicite et éclairé.

Les décisions déjà prises dans ce projet répondent point par point :

| Critère de Google | Ce que le projet fait déjà |
|---|---|
| Pas de surveillance seule | Le suivi de position n'existe **que** pendant une session ouverte, jamais hors du temps de travail (docs/01 §2.3). |
| Consentement explicite | Le partage d'écran demande l'accord du chauffeur, motif affiché, refus aussi facile qu'accepter (docs/17). |
| Transparence | Notification permanente pendant le suivi, bandeau pendant un partage, kiosque non garanti affiché comme tel (§67). |
| Permissions minimales | Voir §3.3. |

C'est un cas favorable, et il se raconte bien. Il faut le raconter.

### 3.3 Audit des permissions

Les permissions les plus scrutées lors d'un examen de DPC sont **absentes** du
manifeste :

`READ_SMS` · `RECEIVE_SMS` · `BIND_ACCESSIBILITY_SERVICE` ·
`SYSTEM_ALERT_WINDOW` · `READ_CONTACTS` · `READ_CALL_LOG` · `RECORD_AUDIO` ·
`READ_PHONE_STATE` · `PACKAGE_USAGE_STATS`

Aucune. C'est la conséquence directe de la règle §67 : rien n'a été demandé
« au cas où ».

Deux permissions demanderont une justification, et elles en ont une :

| Permission | Justification |
|---|---|
| `ACCESS_BACKGROUND_LOCATION` | Suivi pendant une session, service de premier plan typé, notification permanente. |
| `QUERY_ALL_PACKAGES` | Inventaire pour le blocage d'applications — gestion de parc, catégorie que Google reconnaît. |

`QUERY_ALL_PACKAGES` a été **resserrée** à cette occasion : la détection des
gestionnaires de root n'en dépend plus. Ces six paquets sont maintenant nommés
un par un dans un bloc `<queries>` du manifeste, et un test de parité échoue si
la liste du manifeste et `ROOT_PACKAGES` divergent — sans quoi un gestionnaire
de root ajouté d'un seul côté ne serait jamais détecté, et le contrôle
continuerait de rapporter « terminal sain ».

Une affirmation a aussi été corrigée en passant : un commentaire du code
soutenait qu'un Device Owner échappe au filtrage de visibilité des paquets
d'Android 11. **La documentation Google ne le dit nulle part.** Le commentaire
disait vrai peut-être, mais sans preuve — ce que §67 interdit. Il énonce
maintenant l'incertitude et sa conséquence observable : si la liste revenait
tronquée, des applications bien présentes seraient rapportées « absentes du
téléphone » au lieu d'être masquées. Le constat remonté par chaque appareil
permet de le voir.

## 4. Recommandation

1. **Déposer la demande d'inscription du DPC auprès de Google, maintenant.**
   C'est le chemin critique : sans elle, la Phase 5 ne démarre pas.
2. **Trancher la question du Play Store** avant d'écrire quoi que ce soit. Si la
   réponse est « non, les chauffeurs n'installent rien », l'architecture actuelle
   tient, et l'installation d'APK (§1) suffit.
3. **Écrire l'installation d'APK** avec ses trois verrous — empreinte, signature,
   audit. C'est utile quelle que soit la réponse au point 2 : même sous AMAPI,
   pousser un APK signé reste nécessaire.

## 5. Sources

- [Register for the EMM Community — Google Play EMM API](https://developers.google.com/android/work/play/emm-api/register)
- [Approved Android Enterprise device policy controllers allowlist](https://support.google.com/work/android/answer/16694822)
- [Google Play Protect is now the custom DPC gatekeeper — Jason Bayton](https://bayton.org/blog/2025/12/the-dpc-allowlist/)
- [Play Protect blocked my DPC, why? — Jason Bayton](https://bayton.org/android/android-enterprise-faq/play-protect-blocked-my-dpc-why/)
- [Manage custom apps with AMAPI](https://developers.google.com/android/management/manage-custom-apps)
- [Package visibility filtering on Android](https://developer.android.com/training/package-visibility)
