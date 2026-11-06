#!/usr/bin/env bash
# `pnpm dev:up` (P0-WP11): builds the agent, platform and portal-web images and starts the Compose
# stack with fakes. Run inside the WSL distro with rootless Docker (docs/runbooks/compose-dev-stack.md).
# Env: EXECUTOR_SLOTS (default 8; the load test uses 20).
set -euo pipefail
cd "$(dirname "$0")/../.."
compose_dir=infra/compose
env_file="$compose_dir/.env"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
socket="${DOCKER_HOST#unix://}"
[ -S "$socket" ] || { echo "dev-up: no rootless Docker socket at $socket (docs/runbooks/wsl2-rootless-docker.md)" >&2; exit 1; }
docker info --format '{{.SecurityOptions}}' | grep -q rootless || { echo "dev-up: the Docker daemon is not rootless (hard rule 6)" >&2; exit 1; }

# After a failover drill the promoted replica holds the `db` alias; restarting the old primary
# would give two databases that name (services would split between them). Reset first.
if docker inspect -f '{{json .NetworkSettings.Networks}}' adlc-pg-replica-1 2>/dev/null | grep -q '"db"'; then
  echo "dev-up: the stack is in its post-failover state (pg-replica is \`db\`). Reset it: pnpm dev:down --volumes" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$compose_dir/images.env"
set +a

# Random dev secrets, created once; keys added in later versions are appended to an existing file.
(
  umask 077
  touch "$env_file"
  for key in POSTGRES_PASSWORD REPLICATION_PASSWORD APP_DB_PASSWORD FAKES_TOKEN INTERNAL_API_TOKEN KEYCLOAK_ADMIN_PASSWORD ADLC_DEV_USER_PASSWORD MODEL_API_KEY; do
    grep -q "^$key=" "$env_file" || { echo "$key=$(openssl rand -hex 24)" >>"$env_file"; echo "dev-up: generated $key in $env_file"; }
  done
)

echo "dev-up: building the agent runtime image"
pnpm install --frozen-lockfile >/dev/null
pnpm -s turbo run build --filter=@adlc/agent-runtime... --output-logs=errors-only
pnpm -s --filter @adlc/agent-runtime build:bundle
docker build -q --build-arg "BASE_IMAGE=$NODE_IMAGE" -t adlc-agent-runtime:dev apps/agent-runtime >/dev/null
# The local image ID is a sha256 digest: the executor only runs images it is pinned to (hard rule 6).
AGENT_IMAGE="$(docker image inspect -f '{{.Id}}' adlc-agent-runtime:dev)"

echo "dev-up: building the platform and portal-web images"
for target in platform portal-web; do
  docker build -q -f infra/docker/platform.Dockerfile --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NGINX_IMAGE=$NGINX_IMAGE" \
    --target "$target" -t "adlc-$target:dev" . >/dev/null
done

echo "dev-up: starting the stack (agent image $AGENT_IMAGE)"
AGENT_IMAGE="$AGENT_IMAGE" DOCKER_SOCKET="$socket" EXECUTOR_SLOTS="${EXECUTOR_SLOTS:-8}" \
  docker compose -f "$compose_dir/compose.yaml" --env-file "$compose_dir/images.env" --env-file "$env_file" up -d --wait --remove-orphans
cat <<MSG
dev-up: ready.
  Portal        http://localhost:8081  (users: program-lead, platform-admin, dummy-owner-onduty, viewer;
                                       password: ADLC_DEV_USER_PASSWORD in $env_file)
  Keycloak      http://localhost:8080   Mailpit http://localhost:8025   dev-fakes http://localhost:4000
  Orchestrators http://localhost:3100/ready  http://localhost:3101/ready
MSG
