# Runbook — control-plane failover (active/passive, manual)

**Requirement:**
- NFR-002: RPO 5 minutes and RTO 1 hour for the control plane; active/passive; documented manual failover; failover test in Phase 0.
- AT-P0-06: failover to the passive control plane within RTO; leases resume.

**Scope:** this is the procedure as it runs on the Compose stack ([compose-dev-stack.md](compose-dev-stack.md)). The pilot deployment uses the same steps on its hosts. Its host names, monitoring and who may run the procedure are Pioneer decisions, still open (OPEN-06).

## 1. What is active and what is passive
| Part | Active | Passive | How the passive one takes over |
|---|---|---|---|
| PostgreSQL (leases, Decisions, audit, evidence, queue) | `pg-primary` | `pg-replica`, an asynchronous streaming hot standby | **Manual:** promote it, then point `db` at it. |
| Orchestrator (dispatcher, reaper, supervisor) | the replica holding the advisory lock | every other replica | **Automatic:** on its next poll (2 s) once the database is reachable. |
| Gateway, notifier, portal API | stateless; they reconnect | n/a | They reconnect on the next query. |

- **RPO:** replication is asynchronous, so the data at risk is the replication lag at the moment of loss. Check the lag on the primary (`pg_stat_replication`, `sent_lsn` against `replay_lsn`). Alert above 5 minutes of lag.
- **RTO:** the time from detecting the loss to a leader running on the promoted database. Most of it is a person's reaction time; the steps themselves take seconds.

## 2. Decide to fail over
Fail over only when the primary is **lost**, not merely slow:
- the host or its storage is gone; or
- PostgreSQL will not start and cannot be repaired within the RTO.

Promoting while the old primary is still taking writes makes two primaries (split brain). Make sure the old primary is down, or fenced off from the network, before step 3.

## 3. Procedure
1. **Fence the old primary:** stop it, or cut its network. Compose: `docker stop adlc-pg-primary-1`.
2. **Promote the standby:**
   ```bash
   docker exec adlc-pg-replica-1 psql -U adlc_owner -d adlc -Atc "select pg_promote(true, 60)"   # prints t
   ```
3. **Point `db` at the promoted server.** Services reach the database only through the `db` name:
   ```bash
   docker network disconnect adlc_adlc adlc-pg-replica-1
   docker network connect --alias db --alias pg-replica adlc_adlc adlc-pg-replica-1
   ```
   On hosts, the equivalent is updating the DNS record or the virtual IP behind `db`.
4. **Watch the takeover.** Within seconds:
   - exactly one orchestrator reports `"leader":true` on `/ready`;
   - services log `idle database connection closed` once, then carry on.
5. **Check the work:**
   - running agent containers keep heartbeating through the gateway, and their leases' `expires_at` moves forward;
   - fencing tokens are unchanged;
   - new `To Do` tasks are claimed.
6. **Record the failover:** times, lag, and anything that went wrong, in the incident log.

## 4. What happens to runs in flight
- **Agent containers keep running.** The Docker daemon does not depend on the control plane.
- **Heartbeats during the outage fail;** the agent treats a missed beat as non-fatal. A lease survives three heartbeat intervals (15 minutes in production), so an outage shorter than that loses no lease.
- **The new leader's supervisor** takes over supervision of the existing containers from the database rows.
- **A lease that did expire** is reaped and its task is offered again. The new run resumes from the task branch (AT-P0-03). A late write from the old run carries a stale fencing token and is rejected.

## 5. Re-establish a standby
After a failover there is no standby. Before the next one:
1. Remove the old primary's data, or keep it aside for analysis.
2. Clone the new primary:
   ```bash
   pg_basebackup -h <new primary> -U replicator -D <data dir> -R -X stream
   ```
   `infra/compose/postgres/replica-entrypoint.sh` does this on an empty volume.
3. Start the old primary as a replica.
4. Swap the roles in the configuration.

In the dev stack: `pnpm dev:down --volumes && pnpm dev:up`.

## 6. The drill (AT-P0-06)
`pnpm test:failover` (`scripts/dev/failover-drill.sh`) runs steps 1–5 on the Compose stack with a run in flight. It fails unless all of these hold:
- a new leader is elected and RTO < 1 hour;
- the in-flight lease renews on the promoted database with its fencing token unchanged;
- that run succeeds without a second run;
- a new task is dispatched afterwards.

It prints the measured RTO and the replication lag at the moment of loss.
