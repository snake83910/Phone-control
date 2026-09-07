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

Deux sous-domaines à faire pointer vers l'adresse IPv4 du VPS, en
enregistrements `A` :

```
api.votredomaine.fr     -> 203.0.113.10
admin.votredomaine.fr   -> 203.0.113.10
```

Les séparer n'est pas cosmétique : cela permettra de restreindre plus tard
l'accès au tableau de bord — par adresse, par VPN — sans toucher au trafic des
téléphones, qui vient de n'importe où sur le réseau mobile.

**Attendez que la résolution DNS soit effective avant l'étape 5.** Caddy demande
les certificats au premier démarrage ; s'il échoue, Let's Encrypt applique des
quotas qui vous feront patienter.

### 3.3 Le pare-feu

Dans hPanel : **VPS → Security → Firewall**. Trois ports entrants, et rien
d'autre :

| Port | Pourquoi |
|---|---|
| 22 | SSH |
| 80 | Renouvellement des certificats, redirection vers HTTPS |
| 443 | Tout le reste |

PostgreSQL et Redis n'apparaissent pas dans cette liste, et ne doivent pas y
apparaître : ils ne sont joignables que depuis le réseau interne des conteneurs.

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
  -c "pnpm exec ts-node --transpile-only -P tsconfig.json prisma/seed.ts"
```

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
pilote aucune flotte. Trois étapes dans l'ordre :

1. créer l'entreprise, depuis **Paramètres** ;
2. lui créer un administrateur d'entreprise ;
3. se reconnecter avec ce compte-là.

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
