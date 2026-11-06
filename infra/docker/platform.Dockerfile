# syntax=docker/dockerfile:1
# Platform image for the Compose stack (P0-WP11): every Node.js service from one build, selected by
# the container command (node apps/<service>/dist/main.js). The agent runtime has its own minimal
# image (apps/agent-runtime/Dockerfile) because only that one runs untrusted work (hard rule 6).
# Build from the repository root:
#   docker build -f infra/docker/platform.Dockerfile --build-arg NODE_IMAGE=node@sha256:<digest> \
#     --build-arg NGINX_IMAGE=nginxinc/nginx-unprivileged@sha256:<digest> --target platform .
# Pinned digests live in infra/compose/images.env.
ARG NODE_IMAGE
ARG NGINX_IMAGE

FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
RUN case "${NODE_IMAGE}" in *@sha256:*) ;; *) echo "NODE_IMAGE must be pinned by digest" >&2; exit 1 ;; esac
ENV CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# Portal web is configured at build time (OPEN-22: the dev realm in infra/compose/keycloak).
ARG VITE_OIDC_AUTHORITY=http://localhost:8080/realms/adlc
ARG VITE_OIDC_CLIENT_ID=adlc-portal
RUN pnpm build

FROM ${NODE_IMAGE} AS platform
LABEL org.opencontainers.image.title="adlc-platform" adlc.component="platform"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /src /app
USER node
CMD ["node", "--version"]

FROM ${NGINX_IMAGE} AS portal-web
ARG NGINX_IMAGE
LABEL org.opencontainers.image.title="adlc-portal-web" adlc.component="portal-web"
COPY --from=build /src/apps/portal-web/dist /usr/share/nginx/html
COPY infra/compose/portal-web/nginx.conf /etc/nginx/conf.d/default.conf
