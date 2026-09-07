# =============================================================================
#  Serveur Phone Control — image de production
#
#  Base Debian slim et non Alpine, deliberement : Prisma embarque un moteur de
#  requetes compile, et la variante musl d'Alpine demande une configuration
#  supplementaire pour un gain de quelques dizaines de mega-octets. Le jour ou
#  l'image ne demarre pas sur le VPS, on prefere que ce ne soit pas pour ca.
#
#  L'etage de construction et l'etage d'execution partagent la meme base : c'est
#  ce qui permet a Prisma de detecter le bon moteur sans qu'on ait a le declarer.
# =============================================================================

FROM node:22-bookworm-slim AS build

# openssl est necessaire A LA CONSTRUCTION, pas seulement a l'execution.
#
# Prisma choisit son moteur de requetes d'apres la version d'OpenSSL qu'il
# detecte. Sans le binaire, la detection echoue et retombe sur
# `debian-openssl-1.1.x` — alors que Bookworm embarque OpenSSL 3. L'image se
# construit sans le moindre avertissement, et le serveur meurt au demarrage sur
# un moteur introuvable.
RUN apt-get update  && apt-get install -y --no-install-recommends openssl  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /repo

# Les manifestes d'abord, les sources ensuite : tant qu'aucune dependance ne
# change, l'installation reste en cache, et une modification de code se
# reconstruit en quelques secondes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/provisioning-payload/package.json packages/provisioning-payload/
COPY packages/state-machine-spec/package.json packages/state-machine-spec/

RUN pnpm install --frozen-lockfile --filter @phone-control/api... --filter .

COPY packages/provisioning-payload packages/provisioning-payload
COPY apps/api apps/api

# Le paquet partage d'abord : le serveur en depend pour lire le bloc de
# signature d'un APK.
RUN pnpm --filter @phone-control/provisioning-payload build \
 && pnpm --filter @phone-control/api exec prisma generate \
 && pnpm --filter @phone-control/api build

# `pnpm deploy` reconstruit une arborescence autonome, dependances de production
# uniquement, liens symboliques resolus. Sans cela, il faudrait embarquer tout
# le magasin pnpm du dépôt.
RUN pnpm --filter @phone-control/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist \
 && cp -r apps/api/prisma /out/prisma

# Le client Prisma GENERE ne suit pas `pnpm deploy`.
#
# `prisma generate` ecrit le client dans le magasin pnpm de l'espace de travail,
# sous `.prisma/client`. `pnpm deploy` reconstruit une arborescence neuve a
# partir du magasin, sans cette sortie : l'image se construit sans erreur, et
# l'API meurt au demarrage sur un `MODULE_NOT_FOUND` qui ne nomme pas la cause.
#
# On recopie donc le client genere a l'emplacement equivalent. Le chemin contient
# la version et le hachage des pairs, d'ou la resolution par motif plutot qu'en
# dur : un chemin fige se casserait a la prochaine montee de version de Prisma,
# et se casserait en silence.
RUN set -eu;     src="$(find /repo/node_modules/.pnpm -type d -path '*@prisma+client@*/node_modules/.prisma' | head -1)";     dst="$(find /out/node_modules/.pnpm -maxdepth 3 -type d -path '*@prisma+client@*/node_modules' | head -1)";     test -n "$src" || { echo 'ECHEC : client Prisma genere introuvable'; exit 1; };     test -n "$dst" || { echo 'ECHEC : @prisma/client absent de l arborescence deployee'; exit 1; };     cp -r "$src" "$dst/.prisma";     test -f "$dst/.prisma/client/index.js" || { echo 'ECHEC : copie du client Prisma incomplete'; exit 1; }


# -----------------------------------------------------------------------------
#  Etage des migrations.
#
#  Il conserve l'outillage de construction, la CLI Prisma comprise. L'image
#  d'execution, elle, ne l'embarque pas : un serveur en production n'a aucune
#  raison de pouvoir modifier son propre schema.
#
#  Sans cet etage separe, `npx prisma` dans l'image finale irait telecharger une
#  version arbitraire de Prisma depuis le reseau, au demarrage, en production.
# -----------------------------------------------------------------------------

FROM build AS migrate

WORKDIR /repo/apps/api
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# -----------------------------------------------------------------------------

FROM node:22-bookworm-slim AS runtime

# openssl : exige par le moteur Prisma.
# tini    : sans lui, le processus Node tourne en PID 1 et n'a pas de
#           gestionnaire de signaux par defaut — `docker stop` attend alors dix
#           secondes puis tue brutalement, en pleine ecriture le cas echeant.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out /app

# Les APK deposes vivent ici. Le repertoire appartient a l'utilisateur non
# privilegie : le serveur y ecrit, personne d'autre.
RUN mkdir -p /app/storage/app-packages && chown -R node:node /app/storage

USER node
EXPOSE 3001

# Le conteneur se declare pret seulement quand la base repond : sans cela,
# le reverse proxy enverrait du trafic a une instance qui ne peut rien servir.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
