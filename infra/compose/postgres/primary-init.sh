#!/usr/bin/env bash
# First start of the primary (docker-entrypoint-initdb.d). POSTGRES_USER is the owner role that runs
# migrations. Adds the streaming-replication role and the application role services connect as
# (P0-WP11; grants are applied after each migration by APP_DB_ROLE in packages/db/src/migrate-cli.ts).
set -euo pipefail
: "${REPLICATION_PASSWORD:?}" "${APP_DB_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v repl_pw="$REPLICATION_PASSWORD" -v app_pw="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'repl_pw';
CREATE ROLE adlc_app WITH LOGIN PASSWORD :'app_pw';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
