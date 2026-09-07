# 17 — Vision d'écran avec accord du chauffeur

État : **fait et vérifié de bout en bout**, hors capture réelle qui exige un
téléphone.

Ce document décrit ce que le dispositif garantit. Ces garanties ne sont pas des
intentions : chacune est tenue par du code testé, et la liste des tests figure
au §6.

## 1. Ce que le dispositif fait, et ce qu'il ne fait pas

| | |
|---|---|
| **Il fait** | Un administrateur demande à voir l'écran d'un téléphone, en écrivant pourquoi. Le chauffeur accepte ou refuse. S'il accepte, l'écran est transmis sous forme d'images, quelques-unes par seconde. |
| **Il ne fait pas** | Prendre la main sur le téléphone. Voir un écran sans accord. Conserver la moindre image. Durer indéfiniment. |

Le contrôle à distance — toucher l'écran à la place du chauffeur — reste hors
de portée sans licence Samsung Knox, et le *remote viewing* de Knox est de toute
façon déprécié depuis l'API 35 (docs/16 §2).

## 2. Les quatre garanties

### 2.1 Aucune image sans accord

Une capture n'est acceptée que dans l'état `ACCEPTED`. Ni avant la réponse du
chauffeur, ni après la fin, ni après l'échéance. La vérification a lieu **à
chaque image**, côté serveur, et le refus est un `403` — le téléphone doit
s'arrêter, pas réessayer.

L'accord ne se donne que depuis le téléphone, avec son propre jeton. Un
administrateur qui appellerait la route de consentement reçoit un `401`.

### 2.2 Deux consentements, pas un

Le chauffeur voit **notre** écran de demande — qui demande, pourquoi — puis la
boîte de dialogue système d'Android, qui dit ce qui va être capturé. La seconde
est imposée par Android à chaque séance ; on ne cherche pas à la contourner,
c'est elle qui rend la capture impossible à mener en douce.

Sur notre écran, **refuser est aussi facile qu'accepter** : mêmes dimensions,
même poids visuel. Un bouton de refus discret serait une façon polie de forcer
la main.

### 2.3 Toute séance se termine seule

Deux limites distinctes, toutes deux configurables (§61) :

| Réglage | Défaut | Ce qu'il borne |
|---|---|---|
| `SCREEN_SHARE_RESPONSE_TIMEOUT_SECONDS` | 120 s | Le temps laissé au chauffeur pour répondre |
| `SCREEN_SHARE_MAX_DURATION_SECONDS` | 600 s | La durée du partage une fois accordé |

À l'acceptation, l'échéance est **remplacée**, pas prolongée : additionner les
deux donnerait au chauffeur qui hésite un partage plus long.

L'échéance est vérifiée **des deux côtés**. Côté serveur à la lecture, ce qui la
rend indépendante d'un ordonnanceur qui tomberait. Côté téléphone dans la boucle
de capture, ce qui compte davantage : un appareil qui perd le réseau juste après
l'accord ne recevra jamais l'ordre d'arrêt, et doit cesser tout seul.

### 2.4 Aucune image n'est conservée

Les captures traversent le serveur et disparaissent. Elles ne sont écrites ni en
base, ni en fichier, ni en journal. Elles sont relayées par le canal temps réel
au **seul administrateur qui a demandé** — pas à la salle de l'entreprise, pas
aux super-administrateurs.

Ce qui reste en base, c'est le contexte : qui a demandé, pourquoi, qui était en
session, ce qui a été répondu, quand, et **combien d'images ont transité**. Le
volume dit ce qui a été vu ; l'image n'a pas à être gardée pour cela.

C'est la distinction qui change la qualification juridique du traitement :
assistance ponctuelle et tracée d'un côté, captation de l'autre.

## 3. Un conflit trouvé en chemin : `FLAG_SECURE`

L'application posait `FLAG_SECURE` en permanence sur sa fenêtre, pour que le
numéro de badge affiché à l'écran de scan ne se retrouve ni dans une capture ni
dans la vignette du sélecteur d'applications. Un badge photographié se rejoue.

Ce même drapeau rend l'application **entièrement noire** dans un partage
d'écran — c'est son rôle. Or le cas d'assistance le plus fréquent est
précisément « le chauffeur ne trouve pas le bouton dans l'application » :
l'écran qu'on veut montrer aurait été le seul invisible.

L'arbitrage retenu :

| Écran | Hors partage | Pendant un partage accepté |
|---|---|---|
| Lecture de badge | masqué | **masqué** |
| Tous les autres | masqué | visible |

Le badge reste protégé. Le reste devient montrable, avec l'accord de la personne
concernée.

Le commentaire d'origine avertissait qu'un drapeau qu'on lève et qu'on repose au
fil des écrans finit par être oublié en position basse — et qu'un oubli au
retrait ne se voit pas. L'avertissement était juste, donc la décision vit
maintenant dans une **fonction pure et testée**, `shouldMaskScreen`, appelée
depuis un seul endroit. Trois tests fixent l'arbitrage, dont celui-ci : hors
partage, tout est masqué, quel que soit l'écran.

## 4. Choix techniques

### 4.1 Des images, pas de la vidéo

Une capture toutes les 800 ms, JPEG qualité 55, résolution divisée par deux.

C'est suffisant pour accompagner quelqu'un à l'écran, et cela divise la
consommation de données mobiles par un ordre de grandeur par rapport à un flux
vidéo. Le choix est assumé : c'est un outil d'assistance, pas un outil
d'observation — et sur une flotte facturée au forfait mobile, la différence se
lit sur la facture.

### 4.2 Ce qu'Android impose et qu'on ne contourne pas

- Service de premier plan typé `mediaProjection`, avec notification permanente.
- Indicateur système de capture, en plus de la notification.
- Boîte de dialogue de consentement à chaque séance.
- Depuis Android 14, le service doit être au premier plan **avant** d'obtenir la
  projection ; l'inverse lève une `SecurityException`.

On y ajoute un bandeau rouge permanent dans l'application, avec l'arrêt à portée
de pouce, et une action « Arrêter » dans la notification. Un consentement qu'on
ne peut pas retirer facilement n'en est pas vraiment un.

### 4.3 Le piège du remplissage de ligne

`ImageReader` aligne chaque ligne sur une largeur matérielle qui dépasse souvent
celle demandée. Ignorer ce `rowPadding` produit une image oblique — défaut
classique et spectaculaire. Il est traité, et commenté à l'endroit où il se
joue.

## 5. Parcours complet

1. L'administrateur ouvre la fiche du téléphone, écrit un motif d'au moins dix
   caractères, et demande. Un motif de trois mots est refusé.
2. Le serveur crée la séance en `REQUESTED` et émet une commande de réveil, dont
   la durée de vie ne dépasse pas le délai de réponse.
3. Le téléphone affiche la demande : qui, pourquoi, et ce qui se passera. Le
   dashboard, lui, affiche « rien ne s'affiche tant que le chauffeur n'a pas
   accepté » — et non un cadre noir qu'on prendrait pour une lenteur du réseau.
4. Le chauffeur accepte, puis confirme dans la fenêtre système d'Android.
5. Les images arrivent. Le chauffeur voit un bandeau, une notification et
   l'indicateur système.
6. Fin : par le chauffeur, par l'administrateur, ou par l'échéance. Chaque état
   terminal dit **qui** a mis fin à la séance.

Si le chauffeur annule la fenêtre système, la séance passe à `FAILED` avec un
motif affiché — pas à un écran vide qu'on attribuerait au réseau (§67).

## 6. Vérifications

| Quoi | Combien | Où |
|---|---|---|
| Machine à états, serveur | 29 tests | `apps/api/src/screen-share/rules.spec.ts` |
| Machine à états, téléphone | 8 tests | `ScreenShareRulesTest` |
| Routes, bout en bout | 23 tests | `apps/api/test/screen-share.e2e-spec.ts` |

Les deux machines à états sont soumises **aux mêmes scénarios**
(`packages/state-machine-spec/scenarios/screen-share.json`). Sans ce dispositif,
le téléphone pourrait capturer dans un état que le serveur refuse : l'écran
partirait, le serveur le rejetterait, et personne ne saurait dire ce qui a été
montré.

Chaîne complète exercée sur les serveurs en fonctionnement : demande depuis le
navigateur, accord et envoi d'une image par un téléphone enrôlé pour l'occasion,
affichage de l'image dans le navigateur demandeur, puis arrêt par le chauffeur —
après quoi l'image disparaît de l'écran et toute nouvelle capture est refusée
par un `403`.

## 7. Ce qui reste à constater sur un téléphone

La capture elle-même. Le code compile, l'APK se construit, mais aucune image n'a
été produite par un vrai `MediaProjection` — cela exige un appareil.

Trois points à vérifier en priorité sur un Samsung A16 :

| Point | Pourquoi |
|---|---|
| Lisibilité à qualité 55 et demi-résolution | Réglages choisis pour le débit ; à confirmer sur un écran réel. |
| Comportement du service face à l'optimisation de batterie Samsung | Les gammes A endorment agressivement les services d'arrière-plan. |
| Levée effective de `FLAG_SECURE` pendant un partage | Le drapeau est appliqué depuis un seul endroit, mais son effet se constate à l'œil, pas au test. |
