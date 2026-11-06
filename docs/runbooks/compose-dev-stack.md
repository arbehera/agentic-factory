# Runbook — the Compose dev stack (with fakes)

**Scope:** dev and CI only (P0-WP11, ADR-0014). It runs every platform service against fake Jira and GitHub (`apps/dev-fakes`), a local Keycloak realm with placeholder users, and Mailpit as the mail sink. Nothing here is Pioneer-specific, and nothing here is a production deployment.

**Prerequisite:** the WSL2 distro with rootless Docker from [wsl2-rootless-docker.md](wsl2-rootless-docker.md). `scripts/dev/check-rootless-docker.sh` must pass.

## 1. Start
Run inside the WSL distro, in a Linux-filesystem clone (e.g. `~/src/adlc-platform`):

```bash
pnpm dev:up                     # EXECUTOR_SLOTS=20 pnpm dev:up for the load test
```

`dev:up` does five things:
1. Refuses to run unless the daemon is rootless (hard rule 6).
2. Creates `infra/compose/.env` with random dev secrets on first run. The file has mode 600 and is git-ignored.
3. Builds three images:
   - the agent runtime image, run by its local image ID, which is a `sha256` digest the executor is pinned to;
   - the platform image (every Node.js service);
   - the portal-web image.
4. Starts the stack, waiting for every health check to pass.
5. Prints the URLs.

**Keep the distro running.** WSL stops a distro shortly after its last process exits, even with linger on, and the rootless daemon and the whole stack stop with it. Keep a WSL terminal open while you use the stack, or run `wsl.exe -d <distro> sleep infinity` in a spare Windows terminal.

All third-party images are pinned by digest in `infra/compose/images.env`. To refresh the pins, run `scripts/dev/pin-images.sh` and review the diff.

| Service | URL (host) | Notes |
|---|---|---|
| Portal | http://localhost:8081 | Sign in as `program-lead`, `platform-admin`, `dummy-owner-onduty` or `viewer`. The password is `ADLC_DEV_USER_PASSWORD` in `.env`. |
| Keycloak | http://localhost:8080 | Realm `adlc` (`infra/compose/keycloak/realm-adlc.json`). The admin password is in `.env`. |
| Mailpit | http://localhost:8025 | Every email the notifier sends. |
| dev-fakes | http://localhost:4000 | `POST /admin/seedIssue` etc. with `Bearer $FAKES_TOKEN` (see `packages/testing/src/fakes-server.ts`). |
| Orchestrators | http://localhost:3100/ready, http://localhost:3101/ready | `leader: true` on exactly one of them. |

## 2. Run a task
Seed a `To Do` task in the fake Jira. The leader dispatches it to the `dummy` role, and an agent container starts on the internal `adlc-agents` network, where it can reach only the gateway. The agent:
1. creates `task/PILOT-1`;
2. commits `docs/dummy/PILOT-1.md`;
3. opens a PR;
4. comments on the issue.

The orchestrator then moves the task to In Review.

```bash
. infra/compose/.env
curl -s -H "authorization: Bearer $FAKES_TOKEN" localhost:4000/admin/seedIssue \
  -d '{"args":[{"key":"PILOT-1","type":"Task","status":"To Do","summary":"try it","description":""}]}'
curl -s -H "authorization: Bearer $FAKES_TOKEN" localhost:4000/admin/state
```

## 3. Stop
```bash
pnpm dev:down              # keeps data
pnpm dev:down --volumes    # also deletes the databases and SeaweedFS data
```
Failed agent containers are kept for diagnosis (ADR-0011). List them with `docker ps -a --filter label=adlc.managed=true`.

## 4. What is where
- **Database roles:**
  - Services connect as `adlc_app` through the `db` alias. That role cannot update, delete or truncate the write-once tables, and it owns nothing.
  - Migrations run as `adlc_owner` in the one-shot `migrate` service, which also applies the dev seed (project `PILOT`, repo `org/product`, the Phase 0 agent definitions).
- **Executor hosts:** the orchestrators mount the rootless Docker socket and run as uid 0 inside a rootless daemon, which is the unprivileged host user, with no capabilities. Agent containers never get the socket.
- **Failover:** the replica `pg-replica` streams from `pg-primary`. See [control-plane-failover.md](control-plane-failover.md).
