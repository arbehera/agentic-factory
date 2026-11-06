#!/usr/bin/env bash
# Passive PostgreSQL (NFR-002): on first start, clone the primary with pg_basebackup and stream WAL
# from it as a hot standby. Promotion is manual (docs/runbooks/control-plane-failover.md).
set -euo pipefail
: "${REPLICATION_PASSWORD:?}" "${PRIMARY_HOST:=pg-primary}"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 0700 "$PGDATA"
  until pg_isready -q -h "$PRIMARY_HOST" -U replicator -d postgres; do sleep 1; done
  echo "replica: cloning $PRIMARY_HOST"
  gosu postgres env PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup -h "$PRIMARY_HOST" -U replicator -D "$PGDATA" -R -X stream --checkpoint=fast
fi
exec docker-entrypoint.sh postgres -c hot_standby=on
