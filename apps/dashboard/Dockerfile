# =============================================================================
#  Tableau de bord Phone Control — image de production
#
#  Le navigateur n'atteint jamais l'API : il parle a ce serveur, qui detient les
#  jetons dans des cookies httpOnly et relaie. C'est pour cela qu'il tourne
#  comme un service a part entiere et non comme un paquet de fichiers statiques.
# =============================================================================

FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/provisioning-payload/package.json packages/provisioning-payload/
COPY packages/state-machine-spec/package.json packages/state-machine-spec/

RUN pnpm install --frozen-lockfile --filter @phone-control/dashboard... --filter .

COPY packages/provisioning-payload packages/provisioning-payload
COPY apps/dashboard apps/dashboard

RUN pnpm --filter @phone-control/provisioning-payload build \
 && pnpm --filter @phone-control/dashboard build

# -----------------------------------------------------------------------------

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# La sortie autonome de Next attend cette disposition exacte : le serveur a la
# racine, les fichiers statiques a cote. Les separer casse le service des
# ressources sans message d'erreur explicite.
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /repo/apps/dashboard/public ./apps/dashboard/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/dashboard/server.js"]
