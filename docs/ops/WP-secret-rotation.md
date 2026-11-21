<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# Secret rotation, round 2: the datastores and the shared agent key

Round 1 (`docs/ops/secret-rotation.md`) rotated the gateway, Langfuse and os-ui secrets. Round 2
covers the credentials production **still runs at the chart's published defaults**: they were
checked read-only on 2026-11-21 by comparing hashes, and no value was printed.

| Component | Secret / key | Values path | Prod today |
|---|---|---|---|
| Postgres owner (`langfuse`, the plain engine's superuser) | `postgres-langfuse-credentials` / `password` | `postgres.local.password` | default |
| Postgres `litellm`, `dagster`, `polaris`, `agent_runs` | `postgres-<role>-credentials` / `password` | `postgres.extraDatabases[<name>].localPassword` | default |
| Dagster's own copy of its password | `dagster-postgresql` / `postgresql-password` | (none: outside the chart, kept by `resource-policy: keep`) | default |
| ClickHouse (Langfuse user) | `clickhouse-credentials` / `password` | `clickhouse.local.password` | default |
| Valkey (default user) | `valkey-credentials` / `password` | `valkey.local.password` | default |
| MinIO root **secret** key | `object-storage-credentials` / `AWS_SECRET_ACCESS_KEY` | `objectStorage.local.secretKey` | default |
| Shared LiteLLM agent key | `agent-litellm-key` / `apiKey` | `litellmAgentKey.local.value` | default |
| LiteLLM master key (`PROXY_MASTER_KEY`) | `litellm-credentials` / `masterkey` | `litellmMasterKey` | own value since round 1; rotated again because it appeared in a local session transcript (an environment printout) and nowhere else |

Not in round 2:
- The MinIO access key (`agentic-os-local`). It is an identifier, and MinIO service accounts belong to the root user *name*, so it stays.
- `polaris.local.rootClientSecret` (already the install's own value). `rootClientId: root` is an identifier.
- The governance roles (`postgres.governance`, disabled).

**After production is rotated**, the #236 render guard is extended to these values in a follow-up. Until then, the guard would block every deploy.

Everything is driven by `scripts/ops/rotate-secrets.sh ds-*`:
- the code is in `scripts/lib/rotate-datastores.sh` and `scripts/lib/rotation-datastores.py`;
- no value is printed, logged or put on a command line;
- values travel on stdin;
- the output shows names, counts and sha256 prefixes.

## Each component's own mechanism

| Component | How the credential changes | Downtime | Restart |
|---|---|---|---|
| Postgres | `ALTER ROLE <role> PASSWORD '<SCRAM-SHA-256 verifier>'`, run as the owner over pg-0's local socket. The verifier is computed by the tool (RFC 7677, the format PostgreSQL stores as-is), so the clear password never reaches the server or its statement log. | Postgres has **one password per role**. Running pods keep their open connections, but a *new* connection with the old password fails until the reader restarts. The tool runs the ALTER, the Secrets and the restarts back to back. | The readers only. **Not pg-0**: `POSTGRES_PASSWORD` and the init script act only on an empty data directory. |
| ClickHouse | The image entrypoint writes `users.d/default-user.xml` from `CLICKHOUSE_PASSWORD` at **every** start (`manage_clickhouse_user` in `/entrypoint.sh`, 24.8). The user lives in config, so `ALTER USER` does not apply. | Langfuse analytics while ClickHouse restarts. | ClickHouse, then Langfuse web and worker. |
| Valkey | `ACL SETUSER default >new` **adds** the new password, so old and new are both valid. `ds-finish` later runs `ACL SETUSER default <old`. | None. | The readers. **Not Valkey**, so its Langfuse queue is kept. At its next start, `--requirepass` reads the new Secret. |
| MinIO | Root credentials come from `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` at start (no KMS: no config is encrypted with them). | S3 while MinIO restarts (seconds). | MinIO, then its readers. |
| LiteLLM master key | Production has `LITELLM_SALT_KEY` set (round 1), so stored values are encrypted with the salt key and virtual keys are stored as hashes. The master key is then a credential and nothing more. `ds-prepare` refuses `litellm-master` when no salt key is set (then round 1's re-key applies). The Secret is written, then LiteLLM and every reader restarts. | Admin calls between the Secret write and os-ui's restart (seconds). Virtual keys keep working throughout. | LiteLLM and os-ui (`LITELLM_MASTER_KEY`, admin env). `litellm-agent-key-init` reads it at each run. **os-ui-worker holds no admin credential** (`scripts/check-worker-env.mjs`; `ds-verify` checks its pod spec), so it needs no restart. |
| Agent key | LiteLLM 1.109.1 keeps key aliases unique (`_enforce_unique_key_alias`), and `/key/regenerate` is Enterprise-only. So `ds-rekey agent-key`:
1. renames the old key's alias (`/key/update`, `-retired`);
2. writes the Secret;
3. **re-runs the chart's own `litellm-agent-key-init` Job** from the release manifest, which creates the new key under the alias with the chart's budget and models;
4. checks that the new key is served, then restarts os-ui and os-ui-worker.

The Job is not left to the deploy. In the rehearsal, the deploy's Job pod started before Helm had updated the Secret, read the old key and reconciled *that* one, so the new key was never created. The Job also used to end "complete" when `/key/generate` was refused; it now fails, so its `backoffLimit` retries it. | None: the old key works until `ds-finish` deletes it (`/key/delete`). | os-ui and os-ui-worker. |

**About the agent key:** the new key starts with spend 0 in its `budgetDuration` window, so the weekly cap restarts that week. The old key's spend history stays in LiteLLM's logs until the key is deleted.

## Consumers that must restart

The tool discovers the readers from the pod specs (`rotation-checks.py readers`), so a new reader cannot be missed. On production on 2026-11-21 they were:

| Secret | Readers |
|---|---|
| `postgres-langfuse-credentials` | langfuse-web, langfuse-worker, CronJob `pg-dump` (next run), pg-0 (init only) |
| `postgres-litellm-credentials` | litellm, Job `litellm-migrations` (runs on deploy), pg-0 (init only) |
| `postgres-dagster-credentials` | pg-0 (init only) |
| `dagster-postgresql` | dagster-daemon, dagster-webserver, dagster-user-deployments-sovereign |
| `postgres-polaris-credentials` | polaris, pg-0 (init only) |
| `postgres-agent-runs-credentials` | os-ui, os-ui-worker, pg-0 (init only) |
| `clickhouse-credentials` | clickhouse (server), langfuse-web, langfuse-worker |
| `valkey-credentials` | valkey (server, not restarted), langfuse-web, langfuse-worker, litellm, Job `litellm-migrations` |
| `object-storage-credentials` | minio (server), langfuse-web, langfuse-worker, os-ui, os-ui-worker, polaris, trino, data-runner, CronJob `pg-dump`, Job `seaweedfs-bucket-init` |
| `agent-litellm-key` | os-ui, os-ui-worker, Job `litellm-agent-key-init` |
| `litellm-credentials` (`masterkey`) | litellm, os-ui, Job `litellm-agent-key-init` (not os-ui-worker) |

Run `ds-plan` for the list on the cluster as it is at the time of the window.

## Order, and why

Run the components in this order: valkey, postgres, clickhouse, minio, litellm-master, agent-key. Then run the deploy.

The master key goes before the agent key: the agent key's alias rename and the key-init Job use the master key that is in the Secret at that moment, and LiteLLM must already run with it.

`ds-rekey` writes the database side, the Secret and the restarts **before** the deploy, because of the Postgres reconcile hook:
- the hook `pg-extra-databases-reconcile` (post-upgrade) connects as the owner with the password *in the Secret*;
- if a deploy wrote a new owner password before the database had it, the hook would fail, and with it the upgrade.

After `ds-rekey`, the deploy:
- carries the same values into the release (the Secrets do not change again);
- lets the hook re-assert the same passwords (idempotent);
- lets key-init create the new agent key.

**Between `ds-rekey` and the deploy, nobody deploys from older values.** Such a deploy would put the defaults back.

## Run-book (production; the owner approves the window)

Common flags: `--context dmagenticos`, plus the defaults `--namespace agentic-os --release agentic-os`. Each `ds-rekey` without `--apply` shows what it would do.

1. **Prepare** (read-only, writes only the private files).

   `scripts/ops/rotate-secrets.sh ds-prepare --context dmagenticos`
   - Checks:
     - each live Secret equals the release value, so nothing was edited by hand;
     - each current credential works.
   - Records data counts:
     - Postgres tables per database;
     - ClickHouse rows;
     - objects per bucket;
     - Valkey keys.
   - Writes three files (mode 600) under `~/.sovereign-os-secrets/overlays/`:
     - `datastores-<time>.yaml`;
     - `.rollback.yaml`;
     - `.state.json`, which binds them to the cluster (kube-system UID), namespace and release.
2. **Plan** (read-only).

   `ds-plan --overlay <file>`
   - Per Secret: old → new (sha prefixes), "to do / done".
   - The readers per component.
   - The chart render with the overlay compared with the live manifest: only these Secrets may change.
3. **Re-key, component by component**, with `--apply`. Each step waits for every restarted reader to be Ready.
   1. `ds-rekey valkey --overlay <file> --apply`
   2. `ds-rekey postgres --overlay <file> --apply`
   3. `ds-rekey clickhouse --overlay <file> --apply`
   4. `ds-rekey minio --overlay <file> --apply`
   5. `ds-rekey litellm-master --overlay <file> --apply`
   6. `ds-rekey agent-key --overlay <file> --apply`

   After each step: `ds-verify --overlay <file> --component <c>`.
4. **Deploy the overlay**, so the release carries the values.

   `VALUES_OVERLAY=<file> scripts/deploy.sh <current version>`
   - The deploy's secret preflight, backup gate and capacity gate apply as usual.
   - Every Secret already holds its new value, so the deploy changes none of them. The reconcile hook re-asserts the Postgres passwords.
5. **Verify everything.**

   `ds-verify --overlay <file>`
   - New credentials accepted.
   - Old ones refused (Valkey and the agent key say "expected until ds-finish").
   - Counts not lower than before.
   - Every reader serves from pods started after its Secret changed.
   - No live unowned pod reads a rotated Secret.
6. **Finish.**

   `ds-finish --overlay <file> --apply`
   - Removes the old Valkey password.
   - Deletes the old agent key. This refuses while the new key is not served.
   - The old master key needs no step: LiteLLM refuses it from the moment it restarted.

   Then run `DS_FINISHED=1 ds-verify --overlay <file>`: **every** old credential must now be refused.
7. **Make the values permanent.** They are in the release now, so later plain deploys derive them. Keep the overlay with the other private overlays. Then do the guard follow-up (extend #236 to these paths).

## Rollback

Per component, before the deploy:

`ds-rekey <c> --overlay <file> --apply --rollback`

This applies the previous values the same way:
- Postgres: ALTER ROLE back to the old password, the Secrets, the readers;
- Valkey: adds the old password back;
- ClickHouse and MinIO: the old Secret and a restart.

After the deploy, roll back with:
1. `VALUES_OVERLAY=<file>.rollback.yaml deploy.sh`;
2. `ds-rekey --rollback` for the database side.

The old agent key can be used again only until `ds-finish` deletes it.

## Rehearsal

`bash scripts/tests/secret-rotation/rehearse-round2.sh` runs on kind, from defaults, with the pinned images (`round2-kind-up.sh`, `values.round2.kind.yaml`):
- the production shape: local profile, Ingress on, persistence on, plain Postgres, bundled MinIO;
- the readers that run without the OS's own images: Langfuse web and worker, LiteLLM and its agent key, and Polaris.

It runs the **real** `rotate-secrets.sh ds-*` and the chart's real hooks and Jobs, and ends with `ROUND2_REHEARSAL_OK`. Results are under "Rehearsal results".

## Findings while rehearsing (fixed in the tooling)

- **Postgres trusts loopback.** The official image's initdb writes `host all all 127.0.0.1/32 trust`, so inside pg-0 *any* password works over 127.0.0.1. Login checks therefore connect to the pod address, the `scram-sha-256` line every reader matches. This is pod-local, but `pg_isready`-style checks over loopback prove nothing about a password.
- **`rollout status` returns while old pods are still terminating**, and those pods still hold the old value. Every restart waits until no pod of the previous revision is left.
- **bash 3.2** (macOS `/bin/bash`), an unset variable and an EXIT trap together end a run with status 0. `rotate-secrets.sh` now treats any run that did not reach its end as a failure.
- **key-init could complete without a key** (see "Agent key" above). It now fails closed.

## Rehearsal results

(filled in by the rehearsal run)
