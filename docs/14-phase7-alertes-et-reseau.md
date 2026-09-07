# 14 — Phase 7 : alertes sortantes et durcissement réseau (livrée)

État : **terminée**. 191 tests serveur, 66 tests Kotlin sur la JVM, 11 tests instrumentés.

Trois ajouts : les alertes atteignent enfin des humains, les téléphones peuvent être
réveillés sans attendre leur prochain sondage, et la connexion peut être épinglée sans
risquer d'immobiliser la flotte.

Deux d'entre eux dépendent de prérequis que le client seul peut fournir — un relais SMTP,
un projet Firebase. Le code est écrit et vérifié jusqu'à la limite de ce qui est vérifiable
sans eux ; le reste est dit au §5.

## 1. Notification des alertes

### 1.1 Ce module décide surtout quand se taire

Une console d'exploitation qui reçoit cinquante notifications pendant un incident réseau
cesse d'être lue, et la première vraie alerte du lendemain passe inaperçue. La logique
d'acheminement (`src/notifications/routing.ts`) est donc autant un filtre qu'un aiguillage :

| Garde-fou | Effet |
|---|---|
| Seuil de sévérité, par canal | `HIGH` par défaut ; abaissable pour un canal de veille |
| Filtre par type d'alerte | un webhook dédié aux sorties de dépôt, un autre à tout |
| Heures creuses | les alertes non critiques attendent le matin |
| Plafond horaire | vingt par défaut, au-delà on se tait |

**Une seule exception, et elle traverse tout : une alerte `CRITICAL` part toujours.** Ni
les heures creuses ni le plafond ne s'y appliquent. Personne ne voudra apprendre qu'une
sortie de dépôt à deux heures du matin n'a pas été signalée parce qu'il était tard.

Les heures creuses sont calculées dans le **fuseau de l'entreprise**, pas celui du serveur :
une flotte française ne se réveille pas à l'heure UTC. Et un fuseau mal orthographié dans la
configuration fait échouer le calcul du côté qui *laisse passer* — le silence est le pire
des échecs pour ce module.

### 1.2 Deux canaux, et un troisième qui attend

Un webhook JSON couvre Slack, Teams, Mattermost, n8n et la plupart des passerelles maison.
Le courriel couvre le reste. Le SMS demande un compte opérateur, un expéditeur déclaré et un
budget : il sera ajouté quand ces trois choses existeront, plutôt qu'écrit à l'aveugle.

La charge utile du webhook est **plate** : aucun objet imbriqué. Celui qui branche un Slack
n'a pas à déplier une structure pour afficher une ligne, et un champ `text` déjà composé lui
évite ce travail.

### 1.3 Rien ici ne peut faire échouer une alerte

L'appel est délibérément **non attendu** par le moteur d'alertes. Un webhook lent ou un
relais SMTP injoignable ne doit retarder ni la réponse à l'appareil qui vient de remonter
l'événement, ni son enregistrement.

C'est testé sous quatre angles : webhook qui répond 500, webhook injoignable, configuration
invalide, aucune configuration. Dans les quatre cas l'alerte existe, reste visible dans le
dashboard et dans le flux temps réel — seul `notified_at` reste vide, ce qui est exactement
l'information utile : **personne ne l'a reçue**.

### 1.4 Où vit la configuration

Dans `Company.settings.notifications`. Pas dans `DeviceSettings`, qui descend sur les
téléphones : les adresses de l'exploitation n'ont rien à faire sur un terminal de chauffeur.
Un test le vérifie explicitement, parce que c'est le genre de fuite qu'on ne remarque pas.

## 2. Épinglage de certificat

### 2.1 La mesure de sécurité qui immobilise le mieux une flotte

L'épinglage protège contre une autorité compromise ou un proxy d'inspection. Il permet aussi,
le jour où le certificat est renouvelé avec une nouvelle clé, d'arrêter tous les téléphones
en même temps — **et le canal qui permettrait de les corriger est justement celui qui est
coupé**.

Deux garde-fous rendent la mesure acceptable, et le module les impose :

1. **Au moins deux empreintes distinctes.** Une pour le certificat en service, une pour
   celui qui prendra sa suite. On publie la version contenant la future empreinte *avant* de
   changer le certificat.
2. **Une date d'expiration.** Passée cette date, l'épinglage se **lève de lui-même**. La
   connexion reste protégée par TLS et la validation ordinaire ; la flotte, elle, continue de
   rouler. Un épinglage périmé est un défaut d'exploitation à corriger, pas une raison
   d'arrêter des camions.

Une politique incomplète, malformée ou sans échéance n'est **pas appliquée** — jamais
appliquée à moitié. Un test vérifie la propriété globale : quelle que soit l'entrée, on
n'obtient jamais « refuser la connexion ».

### 2.2 Vérifié contre une vraie poignée de main

Les sept tests d'intégration montent un serveur TLS et s'y connectent réellement :
la bonne empreinte passe, une empreinte inattendue coupe, l'empreinte de secours est acceptée
comme la principale, et **une politique périmée laisse passer** malgré des empreintes
fausses. Ce dernier point est le plus important à tenir : un épinglage qui coupe est facile
à écrire, c'est la garantie qu'il ne coupera pas la flotte qui demande à être vérifiée.

### 2.3 Configuration

```bash
./gradlew :app:assembleRelease \
  -PpinnedHost=api.exemple.fr \
  -PpinnedPublicKeys=<empreinte>,<empreinte-de-secours> \
  -PpinningExpiresAt=2027-09-05T00:00:00Z
```

Vide par défaut : sans ces valeurs, la connexion reste protégée par TLS ordinaire.

Les empreintes sont fixées à la compilation, donc une rotation exige une nouvelle version de
l'application. C'est ce que la seconde empreinte et l'échéance rendent supportable. La forme
aboutie ferait descendre la politique depuis le serveur ; elle suppose de décider ce qui fait
autorité quand les deux se contredisent, et n'a pas sa place dans une première version.

## 3. Réveil rapide des téléphones

### 3.1 Un accélérateur, jamais une dépendance

Le téléphone interroge déjà le serveur de lui-même : trente secondes en session, cinq minutes
verrouillé, quinze minutes la nuit. FCM ne fait que raccourcir cette attente quand tout va
bien — Play Services présent, Doze coopératif, réseau disponible. **Un parc sans services
Google fonctionne, simplement moins vite** (docs/01 §2.5).

Trois raisons de ne rien envoyer, et aucune n'est un échec : pas de jeton FCM, un réveil déjà
envoyé il y a moins de trente secondes, aucun transport configuré. Dans les trois cas la
commande existe et sera vue à la prochaine synchronisation.

### 3.2 Le message ne commande rien

C'est un **data message**, jamais une notification : rien ne s'affiche sur l'écran d'un
chauffeur. Et il ne transporte aucune instruction — il dit « viens voir ». Le téléphone se
synchronise ensuite par le canal authentifié habituel.

Conséquence directe : **un message FCM falsifié ne peut rien commander.** Un test le vérifie
en s'assurant que les seules données transmises sont un motif et un identifiant de commande.

### 3.3 Ce qui est vérifié sans projet Firebase

L'assertion JWT est construite à la main plutôt qu'empruntée à une bibliothèque — trente
lignes contre une dépendance de plus, pour un chemin qu'on ne peut de toute façon pas
exercer ici. Le gain est réel : dans les tests, **la signature est vérifiée avec la clé
publique correspondante**. Elle est donc valide, pas seulement plausible.

Sont également vérifiés : la portée demandée, l'expiration d'une heure, la forme exacte du
message, la réutilisation du jeton d'accès en cache, le traitement d'un jeton de téléphone
périmé comme un cycle de vie normal, et le fait qu'une clé de service illisible n'empêche pas
l'API de démarrer.

## 4. Côté Android : ce qui n'a pas été ajouté

**Aucun SDK Firebase n'a été intégré.** Il exige un fichier `google-services.json` issu d'un
projet Firebase, sans lequel l'application ne peut obtenir aucun jeton. Ajouter la dépendance
sans pouvoir la configurer ni l'exécuter reviendrait à livrer du code décoratif.

Le contrat, lui, est prêt des deux côtés : le heartbeat accepte un `fcmToken`, le serveur
l'enregistre et sait s'en servir. Le jour où le projet Firebase existe, il reste à obtenir le
jeton et à le joindre au heartbeat.

## 5. Ce qui n'a pas été vérifié, et pourquoi

| Élément | Ce qui manque |
|---|---|
| **Envoi SMTP réel** | Le message est composé et vérifié via le transport de test de nodemailer ; la conversation avec un relais ne l'est pas. Il faut un relais. |
| **Livraison FCM** | Assertion et message sont vérifiés ; que Google les accepte ne l'est pas. Il faut un projet Firebase (prérequis P4). |
| **Épinglage contre le vrai certificat** | Vérifié contre un serveur TLS de test. Le certificat de production n'existe pas encore (prérequis P3). |
| **Réception du réveil sur un téléphone** | Aucun SDK Firebase, aucun terminal. |
| **Latence de bout en bout** | Le livrable annoncé pour la Phase 7 — « alerte `AFTER_RETURN_EXIT` en moins de 5 s » — se mesure sur une chaîne complète avec un téléphone réel. |

## 6. Reste à faire

| Point | Phase | Bloqué par |
|---|---|---|
| Device Owner, Lock Task, restrictions, lanceur persistant | 5 | **un téléphone réinitialisable** |
| Canal SMS | 7 | un compte opérateur |
| Politique d'épinglage descendue par le serveur | 7 ou 8 | rien — arbitrage à faire |
| Empreinte de signature transmise à l'enrôlement | 7 ou 8 | rien |
| Tests de charge, matrice de terminaux, documentation finale | 8 | des téléphones, plusieurs modèles |
