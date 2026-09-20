# 20 — Déploiement sur un VPS

Rien de tout cela n'existait : ce document et l'outillage qu'il décrit ont été
écrits pour cette mise en service, et **vérifiés en exécutant la pile complète**
(§7).

La procédure vaut pour n'importe quel VPS Ubuntu avec accès root. Les quelques
points propres à Hostinger sont signalés.

## 1. Ce que vous allez faire tourner

| Service | Rôle | Exposé publiquement |
|---|---|---|
| `caddy` | TLS et reverse proxy | **oui** — 80, 443 |
| `api` | Serveur, appelé par les téléphones | par Caddy |
| `dashboard` | Tableau de bord, appelé par les navigateurs | par Caddy |
| `worker` | Verrouillage de 22 h, surveillance, purge | non |
| `postgres` | Base de données | **non** |
| `redis` | Compteurs, verrous | **non** |

Différence essentielle avec l'environnement de développement : **aucun port de
base de données n'est publié**. Un VPS a une adresse publique et se fait scanner
dans l'heure qui suit sa mise en ligne ; une base exposée avec un mot de passe
faible n'y survit pas la journée.

## 2. Dimensionner

Le banc de charge (docs/15) donne les ordres de grandeur pour 2 000 téléphones :
6,7 requêtes par seconde de heartbeat, 2,2 de synchronisation. C'est peu. **Le
point de tension n'est pas le processeur, c'est le disque** : 2 000 téléphones
produisent environ trois cents millions de positions par an.

| Parc | Suggestion |
|---|---|
| Jusqu'à ~200 téléphones | 2 vCPU, 8 Go RAM, 100 Go NVMe |
| Jusqu'à ~2 000 téléphones | 4 vCPU, 16 Go RAM, 200 Go NVMe et plus |
| Jusqu'à ~9 000 téléphones | 8 vCPU, 24 Go RAM, 400 Go NVMe et plus |

Pour neuf mille téléphones, ce n'est pas une règle de trois : le processeur
suit très largement — 30 requêtes par seconde de heartbeat contre 616 mesurées
au banc — et c'est la **mémoire** qui commande. L'index
`(company_id, device_id, recorded_at)` sur deux cent vingt millions de lignes
pèse une dizaine de gigaoctets, et il doit rester chaud, sans quoi les
insertions s'effondrent. Le disque, lui, reste modeste : à soixante jours de
rétention, les positions occupent une quarantaine de gigaoctets.

La consommation disque se pilote par la **durée de conservation des positions**,
réglable dans Paramètres, et appliquée par suppression de partition mensuelle —
la réduire libère réellement l'espace. C'est le premier levier à actionner si le
disque se remplit, avant d'acheter du volume.

Chez Hostinger, ces gabarits correspondent aux plans KVM ; le passage à un plan
supérieur se fait sans réinstaller.

## 3. Préparer le serveur

### 3.1 Le système

Dans hPanel : **VPS → OS & Panel → Operating System**. Choisir une image
**Ubuntu**, ou directement le modèle **Docker** qui l'installe déjà. Puis se
connecter en SSH.

Si vous avez pris l'image Ubuntu nue :

```bash
curl -fsSL https://get.docker.com | sh
```

### 3.2 Les noms de domaine

**Trois** sous-domaines à faire pointer vers l'adresse IPv4 du VPS, en
enregistrements `A` :

```
api.votredomaine.fr     -> 203.0.113.10
admin.votredomaine.fr   -> 203.0.113.10
algo.votredomaine.fr    -> 203.0.113.10
```

Les trois, dès maintenant, même si le calculateur ou le MDM ne démarre que
plus tard : Caddy lit tout son fichier et demande un certificat pour chacun
des noms qu'il y trouve, au premier démarrage. Un nom qui ne résout pas fait
échouer sa demande, et Let's Encrypt applique alors des quotas qui font
patienter des heures.

### Des `A`, pas seulement des `AAAA`

Certains hébergeurs — IONOS notamment — créent un enregistrement **AAAA**
(IPv6) et rien d'autre. La pile démarre, les certificats s'obtiennent, tout
paraît normal depuis une machine correctement connectée. Et pourtant :

- **les téléphones** sur un réseau de dépôt ou un APN sans IPv6 ne joignent
  pas le serveur. Du tout. C'est la panne « intermittente et
  incompréhensible » par excellence, puisqu'elle dépend du réseau où se
  trouve l'appareil ;
- **les navigateurs des managers** derrière un réseau d'entreprise en IPv4
  seul ne peuvent pas appeler le calculateur, donc pas générer de planning ;
- **les exécuteurs GitHub Actions n'ont pas d'IPv6.** La tâche nocturne
  d'anticipation des plannings échouerait à chaque passage.

Vérifiez donc que chaque nom rend bien une adresse IPv4 :

```bash
nslookup -type=A api.trajelys.fr
```

Une réponse vide, avec un AAAA présent, est exactement le piège décrit ici.

Les séparer n'est pas cosmétique : cela permettra de restreindre plus tard
l'accès au tableau de bord — par adresse, par VPN — sans toucher au trafic des
téléphones, qui vient de n'importe où sur le réseau mobile.

**Attendez que la résolution DNS soit effective avant l'étape 5.** Caddy demande
les certificats au premier démarrage ; s'il échoue, Let's Encrypt applique des
quotas qui vous feront patienter.

### 3.3 Le pare-feu

Chez Hostinger : **hPanel → VPS → Security → Firewall**.
Chez IONOS : **Cloud Panel → Réseau → Politiques de pare-feu**, en modifiant
la politique attachée au serveur — un VPS IONOS démarre avec une politique
active qui n'ouvre pas 80 et 443.

Trois ports entrants, et rien d'autre :

| Port | Pourquoi |
|---|---|
| 22 | SSH |
| 80 | Renouvellement des certificats, redirection vers HTTPS |
| 443 | Tout le reste |

PostgreSQL et Redis n'apparaissent pas dans cette liste, et ne doivent pas y
apparaître : ils ne sont joignables que depuis le réseau interne des conteneurs.

Le contrôle se fait de l'extérieur, avant de démarrer quoi que ce soit :

```bash
for p in 22 80 443 5432 6379; do
  printf "%-6s " "$p"
  timeout 5 bash -c "</dev/tcp/<ip-du-vps>/$p" 2>/dev/null && echo ouvert || echo ferme
done
```

22, 80 et 443 ouverts ; 5432 et 6379 fermés. Tant que rien n'écoute, 80 et
443 répondront « fermé » même si le pare-feu les autorise — les deux cas sont
indiscernables de l'extérieur, d'où l'intérêt de refaire ce test juste après
le premier démarrage.

## 4. Installer

```bash
git clone <votre-dépôt> /opt/phone-control
cd /opt/phone-control
./deploy/generer-secrets.sh votredomaine.fr exploitation@votredomaine.fr
```

Le script écrit `.env.prod` en permissions 600, génère tous les secrets, et
affiche le mot de passe du premier compte.

**Il refuse d'écraser un fichier existant**, et c'est délibéré : régénérer par
mégarde `BADGE_HMAC_PEPPER` rendrait tous les badges du parc introuvables.

### 4.1 Les trois valeurs à sauvegarder ailleurs, tout de suite

```
BADGE_HMAC_PEPPER      les badges ne sont stockés que sous forme d'empreinte,
                       et l'empreinte dépend de ce poivre
DEVICE_MASTER_KEY      dérive les clés d'authentification hors ligne
BADGE_ENCRYPTION_KEY   si vous l'activez un jour
```

**Une sauvegarde de la base sans ces valeurs ne permet de restaurer aucun
badge.** C'est le point de défaillance le plus discret de toute l'installation :
tout semblera fonctionner jusqu'au jour de la restauration, où plus aucun
chauffeur ne pourra ouvrir de session.

Copiez-les dans un gestionnaire de mots de passe, hors du serveur.

## 5. Démarrer

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Les migrations tournent avant l'API, dans un conteneur dédié. Si elles échouent,
l'API ne démarre pas : une API qui tourne sur un schéma qu'elle ne comprend pas
produit des erreurs incompréhensibles à chaque requête, ce qui est bien pire
qu'un service arrêté.

Puis créer le premier compte :

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm --entrypoint sh migrate \
  -c "pnpm exec ts-node --transpile-only -P tsconfig.json prisma/amorcage.ts"
```

**`amorcage.ts`, et surtout pas `seed.ts`.** Ce dernier annonce en premiere
ligne « Jeu de donnees de demonstration » : il cree aussi « Transports Demo »,
un depot a Marseille, quatre telephones et trois badges. Cette page l'a
prescrit par erreur, et une installation de production est nee avec une flotte
fictive dedans.

`amorcage.ts` ne cree que le super-administrateur. Il exige que l'adresse et le
mot de passe soient fournis — aucune valeur par defaut sur une machine exposee
— et **n'imprime jamais le mot de passe** : celui du seed a fini dans une
transcription le jour de la mise en service.

Vérifier :

```bash
curl https://api.votredomaine.fr/api/v1/health
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

Le `worker` n'affiche volontairement aucun état de santé : il n'expose aucun
serveur HTTP, et un test qui interrogerait un port inexistant le marquerait
« unhealthy » à vie. Mieux vaut aucun test qu'un test qui ment.

## 6. Première connexion

Ouvrez `https://admin.votredomaine.fr` avec le compte affiché par le script.

Vous arrivez sur un écran **« Première mise en service »**, et non sur des
compteurs. C'est normal : le super-administrateur crée les entreprises, il ne
pilote aucune flotte.

Quatre étapes, dont deux passent par l'API — le tableau de bord LISTE les
entreprises et règle leur rétention, il n'en crée pas.

**1. Créer l'entreprise.**

```bash
curl -X POST https://api.<domaine>/api/v1/companies   -H "Authorization: Bearer <jeton-super-admin>"   -H 'Content-Type: application/json'   -d '{"name":"Transports Martin","slug":"transports-martin"}'
```

Elle reçoit du même coup ses durées de conservation et sa configuration
d'appareils, et apparaît ensuite dans **Paramètres**.

**2. La rattacher au compte Trajelys du client** — cf. §9. C'est ce
rattachement qui autorise l'accès, et c'est la décision commerciale.

Les etapes 1 et 2 se font **toutes seules** quand `TRAJELYS_SERVICE_TOKEN` est
pose : ouvrir le module Telephones cote Trajelys cree l'entreprise et la
rattache. Les deux appels ci-dessus restent le chemin manuel — utile pour la
premiere entreprise, pour un client sans module, et le jour ou l'automatisme
se trompe.

**3. Ouvrir le module Téléphones sur son compte Trajelys.** C'est là que vit
l'abonnement. Sans lui, Trajelys refuse d'émettre le code d'ouverture, quel
que soit le rattachement posé à l'étape 2 — et c'est voulu : la barrière
commerciale appartient au produit qui tient la facturation.

**4. Le client ouvre Phone Control depuis Trajelys**, menu *Gestion →
Téléphones*. Son compte administrateur est créé à cette occasion.

Trajelys lui frappe un code à usage unique, valable une minute, et le redirige
sur `https://admin.<domaine>/sso?code=…`, où le tableau de bord l'échange
contre une session. Ce qui traverse l'URL n'est donc ni le jeton Supabase du
client, ni un jeton de ce service.

Cela suppose deux variables posées **côté Trajelys** (sur Vercel), et non ici :

```
PHONE_CONTROL_API_URL=https://api.<domaine>/api
PHONE_CONTROL_DASHBOARD_URL=https://admin.<domaine>
```

Sans elles, la page *Téléphones* de Trajelys affiche « le raccordement n'est
pas encore configuré » plutôt que d'échouer au clic.

### Il n'existe aucun autre moyen de créer un administrateur d'entreprise

Ce n'est pas un manque : c'est la conséquence du modèle. Phone Control se vend
comme un module de Trajelys, l'accès découle du rattachement, et il n'y a donc
ni formulaire d'invitation ni second mot de passe à transmettre.

Le seul code qui crée un `Admin` est l'authentification unique — le compte
super-administrateur mis à part, qui vient du script d'amorçage.

Changez ensuite le mot de passe du super-administrateur, et videz les deux
lignes `SEED_*` de `.env.prod`.

## 7. Ce qui a été vérifié, et comment

La pile complète a été construite et exécutée avant d'écrire ce document.
Quatre défauts en sont sortis, tous invisibles en développement :

| Défaut | Symptôme qu'il aurait produit en production |
|---|---|
| Gestionnaire de paquets non épinglé | L'image tirait pnpm 12 alors que le dépôt est en pnpm 10 : l'installation échouait, avec un message parlant de scripts de construction. |
| `openssl` absent de l'étage de construction | Prisma détectait mal la plateforme et embarquait le moteur OpenSSL 1.1 sur une base OpenSSL 3. **L'image se construisait sans le moindre avertissement**, et le serveur mourait au démarrage. |
| Client Prisma perdu par `pnpm deploy` | `MODULE_NOT_FOUND` au démarrage, sans rapport apparent avec la cause. |
| CLI Prisma absente de l'image | `npx prisma migrate` allait télécharger une version arbitraire de Prisma depuis Internet, au démarrage, en production. |

Aucun de ces quatre-là ne se voit avant d'avoir lancé la pile pour de vrai.

### 7.1 Un cinquième, plus grave

**La page d'accueil répondait 500 au super-administrateur** — c'est-à-dire au
seul compte existant après une installation neuve, à la toute première
connexion, au moment précis où l'on cherche à savoir si le déploiement a réussi.

La cause : dix-huit endroits écrivaient `admin.companyId!`, une assertion qui
ment au compilateur. Un super-administrateur n'est rattaché à aucune entreprise.

Corrigé partout, et couvert par vingt et un tests dont un invariant simple :
**aucune route ne répond en 5xx à un super-administrateur.**

## 8. Exploitation

### 8.1 Sauvegardes

Trois choses à sauvegarder, et elles ne vivent pas au même endroit :

```bash
# 1. La base
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres \
  pg_dump -U phonecontrol phonecontrol | gzip > sauvegarde-$(date +%F).sql.gz

# 2. Les APK déposés
docker run --rm -v phone-control_app-packages:/data -v "$PWD:/sortie" \
  alpine tar czf /sortie/apk-$(date +%F).tar.gz -C /data .
```

**3. Les secrets** — pas sur ce serveur. Voir §4.1.

Hostinger propose des instantanés de VPS dans hPanel : utiles, mais ils ne
remplacent pas un export de base que vous pouvez relire ailleurs.

### 8.2 Mise à jour

```bash
cd /opt/phone-control
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Les migrations s'appliquent seules. Faites une sauvegarde avant.

### 8.3 Journaux

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f worker
```

## 9. Avant d'y brancher des téléphones

Trois points, dans cet ordre d'importance.

### 9.1 N'activez pas l'épinglage de certificat tout de suite

L'application Android sait épingler le certificat du serveur (docs/14). **Ne
l'activez pas avec un certificat Let's Encrypt renouvelé automatiquement.**
Le renouvellement change la clé ; les empreintes inscrites dans l'application ne
correspondent plus ; **toute la flotte cesse de parler au serveur en même
temps**, et le canal qui permettrait de corriger est précisément celui qui vient
d'être coupé.

L'application est conçue pour fonctionner sans épinglage — il se déclare alors
`ABSENT`, et la connexion reste protégée par TLS ordinaire. C'est le bon réglage
pour une mise en service. L'épinglage se rediscutera avec un certificat dont
vous maîtrisez la rotation, et jamais avec moins de deux empreintes.

### 9.2 L'inscription du DPC auprès de Google

Sans elle, le provisionnement Device Owner est bloqué par Play Protect
(docs/18 §3). Le serveur peut tourner ; les téléphones ne pourront pas
s'enrôler en mode kiosque. **Cette demande doit partir avant, pas après.**

### 9.3 Le format des badges

Renseignez `BADGE_FORMAT_PATTERN` dès que le format du parc est connu — pour
huit chiffres, `^[0-9]{8}$`. Sans lui, une saisie fautive devient un badge que
personne ne pourra scanner et que l'on ne saura plus identifier : seuls les
quatre derniers caractères restent visibles.

## 10. Sources

- [Installer Docker sur Ubuntu — Hostinger](https://www.hostinger.com/tutorials/how-to-install-docker-on-ubuntu)
- [Pare-feu VPS géré — Hostinger](https://support.hostinger.com/en/articles/8172641-how-to-use-a-managed-vps-firewall)


## 8. Partager la machine avec le calculateur Trajelys

Le fichier `docker-compose.prod.yml` porte un service `algo` qui n'appartient
pas à Phone Control : c'est le calculateur de Trajelys — génération de planning
par CP-SAT, et OCR des documents véhicule.

### Pourquoi ils cohabitent

Les deux charges sont complémentaires, ce qui est assez rare pour être dit.
Phone Control est limité par la mémoire et les entrées-sorties : il n'utilisera
que deux cœurs sur douze. CP-SAT est du calcul pur, sans état, qui prendrait
tout ce qu'on lui laisse. Les faire tourner ensemble utilise une machine déjà
payée, au lieu d'en louer une seconde qui resterait à moitié vide.

Ils ne se parlent pas. `algo` s'adresse à Supabase par Internet ; Phone Control
à son propre PostgreSQL. Ils partagent le processeur, la mémoire et Caddy —
rien d'autre. Supprimer le service `algo` et son bloc de variables n'affecte
pas Phone Control.

### Les limites ne sont pas de l'optimisation

Sans elles, une résolution CP-SAT à plein régime un jeudi après-midi affamerait
le PostgreSQL qui reçoit les positions de neuf mille téléphones. Le plafond
d'`algo` à six cœurs garantit qu'il en reste toujours six pour le reste.

Somme des limites mémoire : environ seize gigaoctets sur vingt-quatre. Le reste
est laissé délibérément libre — PostgreSQL s'appuie sur le cache de pages du
système, qui est en dehors des limites de conteneur.

### Le piège des cœurs

**Mesuré** : un conteneur lancé avec `--cpus 6` voit quand même douze cœurs.
`nproc` et `os.cpu_count()` ignorent le quota cgroup. Toute bibliothèque qui se
dimensionne dessus sur-alloue — c'est ce qui avait fait passer l'OCR de trois
secondes à plus de dix minutes, OpenMP lisant douze au lieu du quota réel.

**Mesuré aussi, et il faut le dire** : sur CP-SAT, la sur-allocation ne se voit
pas. Comparé à 6, 8 et 12 fils sous un quota de six cœurs, sur deux instances
(soixante et cent trente chauffeurs), la couverture obtenue est identique au
centième. Le solveur est borné en temps : il rend ce qu'il a trouvé au bout de
`CPSAT_MAX_TIME`, donc sur-allouer ne rallonge rien.

`CPSAT_WORKERS` est épinglé à la limite quand même, par précaution et non pour
un gain constaté : la valeur par défaut (8) est écrite dans le code sans
rapport avec ce cgroup, et la prochaine bibliothèque ajoutée sera peut-être,
elle, sensible comme l'était Tesseract.

### Déployer une version du calculateur

L'image est publiée par le workflow `image-algo.yml` du dépôt `planning-dsp`,
qu'un Compose ne peut pas atteindre depuis ici.

```bash
docker compose -f docker-compose.prod.yml pull algo
docker compose -f docker-compose.prod.yml up -d algo
```

Pour revenir en arrière, remplacer `latest` par un SHA dans `ALGO_IMAGE` :
`latest` ne permet pas de dire quelle version tourne.

### Le VPS doit s'authentifier auprès du registre

Le paquet `trajelys-algo` est **privé** — il l'est automatiquement parce que
le dépôt l'est. Vérifiable de l'extérieur : GHCR refuse de délivrer un jeton
de lecture anonyme.

C'est le bon réglage. L'image contient le modèle CP-SAT, les règles métier et
la chaîne OCR : la rendre publique publierait le cœur du produit pour
épargner une ligne de configuration.

Le serveur a donc besoin d'un jeton **en lecture seule**, à créer sur GitHub
dans *Settings → Developer settings → Personal access tokens* — **onglet
`Tokens (classic)`**, avec la seule case `read:packages` cochée.

**Un jeton « fine-grained » ne fonctionne pas ici.** Constaté sur ce serveur :
`docker login` l'accepte sans broncher et l'écrit dans `config.json`, puis
`docker pull` répond `denied`. Le registre délivre alors un jeton opaque au
lieu d'un JWT signé, c'est-à-dire la réponse réservée à un appelant sans
droit. Rien dans le message ne dit que le format du jeton est en cause.

Un jeton classique commence par `ghp_`, un fine-grained par `github_pat_` :
c'est la façon la plus rapide de vérifier lequel est enregistré.

```bash
echo '<le-jeton>' | docker login ghcr.io -u <votre-compte> --password-stdin
```

Le jeton est écrit dans `~/.docker/config.json` du compte qui exécute
Compose. Il ne va **pas** dans `.env.prod` : ce fichier est lu par tous les
conteneurs, alors que le registre ne concerne que le démon Docker.

Un jeton en lecture seule ne peut rien publier : même volé sur le serveur, il
ne permet pas de remplacer l'image par une autre.

### Le sous-domaine du calculateur

`algo.<domaine>` est le troisième, avec `api.` et `admin.` — il figure avec eux
au §3.2. Le séparer permettra de déplacer le calculateur ailleurs sans toucher
au reste.

(Ce paragraphe annonçait un « quatrième » sous-domaine alors que le Caddyfile
n'en sert que trois. Le compte est rétabli : trois blocs, trois noms.)

## 9. Relier un client aux deux produits

L'authentification unique laisse un manager Trajelys ouvrir Phone Control sans
second mot de passe. Elle ne fonctionne que si l'entreprise Phone Control est
**rattachée** au compte Trajelys du client — et ce rattachement ne se fait pas
tout seul.

### Pourquoi ce n'est pas en libre-service

Le compte rattaché devient administrateur de l'entreprise, donc de toute sa
flotte de téléphones. S'il pouvait se rattacher lui-même, il suffirait d'un
compte Supabase pour entrer chez n'importe quel client. C'est une décision
commerciale — le module a été vendu — et elle se prend sous `SUPER_ADMIN`.

### Le geste

Récupérer l'identifiant du compte Trajelys : c'est `dsp.user_id` dans Supabase,
soit le `sub` du jeton.

```bash
curl -X PATCH https://api.<domaine>/api/v1/companies/<id-entreprise>/trajelys \
  -H "Authorization: Bearer <jeton-super-admin>" \
  -H 'Content-Type: application/json' \
  -d '{"trajelysUserId":"65302aeb-03c6-4b0e-9649-9093bfdb7c7a"}'
```

Pour détacher, le même appel avec `{"trajelysUserId": null}`. La clé est
**obligatoire** : un corps vide est refusé plutôt qu'interprété comme un
détachement, qui couperait au client l'accès à sa flotte sur une faute de
frappe.

Un compte déjà rattaché ailleurs donne un `409` qui nomme l'entreprise qui le
détient — l'information dont on a besoin pour trancher.

### Ce que le détachement fait

Il coupe les prochaines connexions **et révoque les sessions déjà ouvertes**
des administrateurs nés de l'authentification unique. Sans cela, un accès
retiré resterait effectif jusqu'à l'expiration du jeton de rafraîchissement,
c'est-à-dire plusieurs jours. Les comptes à mot de passe de la même entreprise
ne sont pas touchés : ils n'ont jamais eu affaire à Trajelys.

La réponse indique combien de sessions ont été coupées.

### Le chemin automatique

Avec `TRAJELYS_SERVICE_TOKEN` pose des deux cotes — ici, et
`PHONE_CONTROL_SERVICE_TOKEN` chez Trajelys — l'ouverture du module fait le
travail : Trajelys appelle `POST /api/v1/integration/trajelys/entreprises`,
qui cree l'entreprise, sa retention, sa configuration d'appareils, et pose le
rattachement.

Trois proprietes a connaitre :

**C'est idempotent.** Rouvrir l'option ne cree pas une seconde flotte. C'est
ce qui permet a Trajelys de refaire l'appel au premier clic du client si cette
machine etait injoignable au moment de la vente : la panne se rattrape seule,
sans file d'attente.

**L'ouverture de l'option ne peut pas echouer** a cause de cette machine.
Trajelys ouvre le module quoi qu'il arrive et signale que l'espace n'a pas ete
cree. Une facturation prise en otage par un serveur tiers serait pire que le
defaut qu'on corrige.

**Ce jeton n'ouvre que deux routes** — creer-et-rattacher, et compter les
appareils a facturer. Aucune position, aucun chauffeur, aucun badge, aucune
commande d'appareil. C'est pourquoi il peut vivre dans les variables d'une
application web, ce qu'un compte super-administrateur n'aurait jamais pu
faire. 32 caracteres au minimum : l'API refuse un secret plus court plutot que
de l'accepter.

### Ce que Trajelys facture, et comment il le sait

Les appareils vivent ici, l'abonnement Stripe vit la-bas. Trajelys **tire**
`GET /api/v1/integration/trajelys/appareils` et **fige** le resultat chez lui,
mois par mois. Il ne compte jamais en direct, pour deux raisons.

La premiere : `invoice.upcoming` part a l'heure de Stripe. Si cette machine
est eteinte ce jour-la, une lecture en direct facturerait zero — en silence,
et en faveur du client, donc personne ne le signalerait.

La seconde : **cette base ne conserve pas l'historique des enrolements**. Un
re-enrolement reutilise la ligne de l'appareil, ecrase `enrolled_at` et remet
`revoked_at` a null. La question « qui etait enrole en janvier » n'a pas de
reponse ici apres coup ; la table figee de Trajelys est la seule memoire.

La regle facturee est l'enrolement, pas l'usage : un telephone sous gestion
coute qu'on s'en serve ou non.

### Rattacher ne suffit pas

Le rattachement ouvre la porte ; c'est le module `module_telephones` du compte
Trajelys qui en donne la clé. Un client rattaché mais dont le module est coupé
voit un écran qui lui propose l'option, et aucun code n'est frappé.

La conséquence à connaître le jour d'une résiliation : couper le module ferme
l'entrée, et les sessions déjà ouvertes s'éteignent d'elles-mêmes (jeton
d'accès de quinze minutes, rafraîchissement de sept jours). Pour couper
immédiatement, c'est le détachement ci-dessus. Dans les deux cas **les
téléphones continuent de fonctionner** : ils portent leurs propres jetons
d'appareil. Une résiliation ferme un tableau de bord, elle n'immobilise pas
une flotte un lundi matin.

### Pas d'écran pour ça

Le tableau de bord n'a pas de section `SUPER_ADMIN` : les entreprises se
créent et se modifient par l'API, comme le reste des opérations
inter-entreprises. C'est un manque assumé tant qu'il y a peu de clients, et le
premier écran à construire le jour où il y en aura.

## 10. Mettre le calculateur en service avant le MDM

L'ordre retenu est : le calculateur d'abord, le MDM ensuite. Une précision
pratique, qui n'est pas évidente à la lecture du Compose.

### Le calculateur ne se déploie pas seul

Il partage ce fichier Compose et ce reverse proxy avec le MDM. « Déployer le
calculateur » veut donc dire démarrer **Caddy et le calculateur**, et laisser
le reste à l'arrêt :

```bash
docker compose -f docker-compose.prod.yml up -d caddy algo
```

### Les trois sous-domaines doivent exister dès maintenant

Caddy lit tout le fichier et demande un certificat pour **chacun** des noms
qu'il y trouve, dès le premier démarrage. Si `api.` ou `admin.` ne résolvent
pas encore, ces demandes échouent et Let's Encrypt applique des quotas qui
font patienter des heures — pour des noms dont vous n'aviez pas encore besoin.

Créez donc les trois enregistrements `A` avant de démarrer quoi que ce soit.
Les sites `api.` et `admin.` répondront 502 tant que leurs services sont à
l'arrêt, ce qui est sans conséquence : Caddy répond lui-même au défi de
validation, il n'a pas besoin que le service derrière soit vivant.

### Basculer Trajelys sur le nouveau calculateur

Une fois `https://algo.<domaine>/health` vert, changer `NEXT_PUBLIC_API_URL`
dans Vercel et redéployer. Garder Render allumé quelques jours : le retour
arrière est alors une variable d'environnement, pas une réinstallation.

Penser aussi aux tâches planifiées de GitHub Actions, qui appellent l'ancienne
adresse en dur : `anticiper-plannings.yml` notamment.

## 11. Qui passe devant, quand la machine est chargée

Le jeudi après-midi, les deux pics sont le même moment : cent cinquante DSP
génèrent leur planning — le calculateur sature ses six cœurs — et consultent
le résultat dans la foulée. Sur une seule machine, ces charges se disputent
les mêmes cœurs.

Les plafonds cumulés du Compose valent vingt-et-un cœurs pour douze réels.
Ce n'est pas une faute : ce sont des maxima, et tout ne culmine pas ensemble.
Mais il fallait décider **à l'avance** qui passe devant.

| Service | Poids | Pourquoi |
|---|---|---|
| `caddy`, `postgres`, `api` | 4096 | Le proxy, la base, et les téléphones |
| `redis` | 2048 | Chemin critique, peu de travail |
| `worker`, `dashboard` | 1024 | Tolèrent quelques secondes |
| `algo` | 256 | Prend tout ce qui est libre, s'efface dès qu'on le bouscule |

Le calculateur **garde son plafond de six cœurs** : le jeudi doit rester
rapide. C'est son poids qui est faible, pas sa limite — il utilise toute la
capacité libre et ne la défend pas.

### Pourquoi `cpu_shares` et pas `reservations`

`deploy.resources.reservations.cpus` est **ignoré par `docker compose`** : ce
réglage ne vaut que pour Swarm. Vérifié en démarrant un conteneur et en
lisant sa configuration — il en sort avec `CpuShares` à zéro. Une réservation
écrite là aurait été une garantie imaginaire, ce qui est pire que pas de
garantie du tout.

Les réservations **mémoire**, elles, sont bien appliquées (`MemoryReservation`
côté noyau) : celles-là restent, sur la base, l'API, Redis et Caddy.
