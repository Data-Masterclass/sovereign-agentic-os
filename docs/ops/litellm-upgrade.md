<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# LiteLLM gateway: upgrading, rolling back, and rotating its keys

For the operator. Three parts: the upgrade procedure (written for 1.90.0 → 1.108.12, valid as a
pattern for the next one), the gateway's own keys, and the rotation of every platform secret on
an install that was deployed with the chart's defaults. **Nothing in the third part has been
executed; it is a procedure for approval.**

## 1. Upgrading the gateway

### What changes between 1.90.0 and 1.108.12

Measured with `scripts/tests/litellm-upgrade/run.sh` (real containers of both versions, the
chart's rendered config and key Job, a stub upstream that records what a Langfuse server would
receive), unless a line says "from source".

| Area | 1.90.0 | 1.108.12 | Consequence here |
|---|---|---|---|
| Security advisories | affected by GHSA-3cv6-jpf6-8222, GHSA-g5ff-637f-6q2m, GHSA-w4c7-34wj-hqm8 ("on Enterprise proxy"), GHSA-2rwg-2wh4-7c4f | all four fixed (the last in 1.108.6) | the reason for the upgrade |
| Database schema | 74 tables, 127 migrations | 110 tables, 220 migrations | **the old proxy runs on the new schema without error; the new proxy on the old schema reports Ready and refuses every call** (`401 … column t.tpd_limit does not exist`). Migrate first — step 4 |
| Spent budget | HTTP **429**, `type: budget_exceeded` | HTTP **422**, same type, message gains `Key=<alias> (sk-...xxxx)` | `isBudgetRejection` accepts 422 (same change). An os-ui older than that shows a spent budget as a raw "LiteLLM 422" error |
| Rate limit (rpm/tpm) | 429, `Rate limit exceeded … Limit type: tokens. Current limit: N, Remaining: 0. Limit resets at: YYYY-MM-DD HH:MM:SS UTC`; headers `retry-after: 60`, `rate_limit_type`, `reset_at` | identical | `rate-limit.ts` needs no change |
| Model outside the key's list | 403, `key not allowed to access model. This key can only access models=[…]`, `type: key_model_access_denied` | 403, `The requested model '…' is not available for this API key, or the model name is invalid…`, same `type` | match on the **type**, not the sentence. An unknown model name is now also 403 (was 400) |
| Deleted or unknown key | 401, `Invalid proxy server token passed. Received API Key = sk-...xxxx, Key Hash (Token) =…`, `type: token_not_found_in_db` | 401, `Invalid API key provided.`, same `type` | same |
| Router fallback target not on the key's list | **served anyway** (the fallback bypassed the key's model list) | refused: `Fallback to <alias> was skipped because the caller is not authorized to call it` (500) | a key now needs every fallback target on its list — `check-litellm-allowlist.mjs` already requires that for the shared key; a system key with a narrower list loses the fallback |
| Key `metadata.allowed_tools` | enforced (403 `tool_access_denied`) | enforced, same | none |
| Langfuse callback (`success_callback: ["langfuse"]`) | Langfuse Python SDK, `POST /api/public/ingestion` (JSON) | OTLP: `POST /api/public/otel/v1/traces` (protobuf) with `x-langfuse-ingestion-version: 4` | needs Langfuse ≥ 3.63 (production: 3.194.1). **Not verified against a real Langfuse server** — check step 6 |
| Trace nesting (`existing_trace_id`, `parent_observation_id`) | any string is used as the trace id, so the gateway's generation lands **inside** the run's trace | an id that is not 32 hex characters is replaced by `sha256(id)[:16]` (hex); a parent id that is not 16 hex characters by `sha256(id)[:8]` (from source and seen in the export) | the OS's trace id is `run_<uuid>`: **the gateway's generations of a run now collect in a second trace**, whose id is the first 16 bytes of `sha256("run_<uuid>")` as hex, instead of nesting in the run's trace. Usage and cost are still recorded; the OS's own trace is unaffected. Restoring one trace means the OS adopting that derived id for Langfuse — a separate change |
| Redaction (`turn_off_message_logging`) on a served call | prompt and completion text redacted; **tool-call arguments logged** | prompt, completion and tool-call arguments redacted | better |
| A call the proxy refuses, with `failure_callback: ["langfuse"]` | the full request body is logged as model parameters, unredacted | the same | fixed by removing the failure callback (the content-hygiene change), on either version |
| Langfuse unreachable | — | calls answer 200, the proxy stays healthy, the export logs a warning and retries | none |
| `drop_params: true` | `reasoning_effort` dropped for these custom models | `reasoning_effort` forwarded upstream | the OS sends none of the affected parameters. The upstream note about `drop_params: false` being ignored in 1.103–1.108 does not apply (the chart sets `true`) |
| Deployment `extra_body` (`chat_template_kwargs.enable_thinking: false`) | reaches the upstream | reaches the upstream | none |
| Prices rendered by Helm as `8e-08` | parsed as a string, still computed correctly | parsed as a float | none |
| Response cache (Valkey, opt-in per request) | chat repeats served from cache; **embedding repeats not** (in the test rig) | the same | not a regression; the embedders' cache opt-in deserves its own look |
| `/key/generate`, `/key/info`, `/key/update` (the bodies Build sends; the fields it reads) | — | identical shapes; `budget_duration: null` clears the window on both | none |
| `/key/info` for a deleted key | 404 | **200** with the old record | do not use `/key/info` to decide whether a key exists; `/key/list?key_alias=` is correct on both |
| Probes `/health/liveliness`, `/health/readiness`; `/` and `/tools/litellm/ui/` | 200 | 200 | none |
| Console sign-in the OS performs (`POST /login`) | 303, cookie `token` | 303, cookie `token` | none |
| `mcp_servers.sovereign_query` | registered | registered | none |
| Admin reads of `core/infra/litellm-admin.ts` | `/global/spend/report`: 400 (Enterprise). `/tag/daily/activity` without dates: 400 | the same | not a regression: **both reads fail on both versions**, so the gateway mirror's per-user and per-tag spend have always been empty. The mirror degrades as designed; the OSS source for per-tag spend is `/spend/tags?start_date=&end_date=` |
| Config versus database precedence (1.103) | a setting stored in the database won | a setting in the config file wins (from the release notes) | only matters for settings changed in the console that the chart also sets; the chart's values now win after every deploy |
| Encryption of stored model credentials | salt key, else master key | the same; optional AES-256-GCM for new writes | a model stored by 1.90.0 decrypts under 1.108.12 (tested) |
| Helm subchart | `litellm-helm` 1.90.0 | 1.108.12: default image repository moved to `ghcr.io/berriai/litellm`; migrations Job gains `activeDeadlineSeconds: 1800` | the chart pins `ghcr.io/berriai/litellm-database` by digest and does not take the repository switch; rendered Deployment, Job and ConfigMap are otherwise unchanged |

### Procedure

1. **Rehearse.** `helm dependency build charts/sovereign-agentic-os`, then
   `scripts/tests/litellm-upgrade/run.sh`. It ends with `LITELLM_UPGRADE_TEST_OK`. With priced
   aliases add `EXTRA_VALUES="-f deploy/overlays/gateway-model-info.stackit.yaml"` so the
   budget case runs. Do not continue on a failure.
2. **Pre-checks.**
   - The os-ui you are about to deploy contains the 422 budget handling
     (`core/infra/litellm-credential.ts`).
   - Langfuse is 3.63 or newer.
   - Note what exists, to compare afterwards: `GET /key/list?size=100` (count, aliases, spend),
     `GET /model/info` (which models have `db_model: true`), `GET /team/list`.
   - No long agent run is in flight (a run in progress sees the gateway restart as failed
     calls and retries).
3. **Back up.** `deploy/pre-upgrade-backup.sh` — the pg dump of every database and the Velero
   backup of the namespace; it aborts if either fails. `scripts/deploy.sh` runs it again as
   its first step; run it here too, because the next step already changes the database.
4. **Migrate first.** `deploy/litellm-premigrate.sh --dry-run`, read what it would create, then
   `deploy/litellm-premigrate.sh`. It renders the chart's own migration Job for the live
   release's values, runs it under a separate name and waits. The old proxy keeps serving
   throughout — it is unaffected by the new schema. In the test the migration took 17 s on a
   small database; the index builds on a large spend log take longer (the script waits 45
   minutes by default).
   If it fails: nothing was upgraded. Read the Job's log; do not deploy.
5. **Upgrade.** `./scripts/deploy.sh --from-registry <os-ui version>`. The chart's own migration
   Job runs again and finds nothing to do; the proxy pod is replaced; the key-init Job reconciles
   the shared key.
6. **Post-checks.**
   ```bash
   kubectl -n agentic-os get pods -l app.kubernetes.io/name=litellm          # Running, 0 restarts
   kubectl -n agentic-os logs job/litellm-agent-key-init                     # "virtual key reconciled"
   kubectl -n agentic-os port-forward svc/agentic-os-litellm 4000:4000 &
   curl -sI localhost:4000/health/liveliness | grep -i x-litellm-version     # 1.108.12
   curl -s -H "Authorization: Bearer $MASTER" localhost:4000/key/list?size=100 | jq '.total_count'   # as noted in step 2
   curl -s -H "Authorization: Bearer $MASTER" localhost:4000/model/info | jq '[.data[]|select(.model_info.db_model)]|length'
   ```
   Then in the OS: Admin → LLM Gateway opens signed in; a short agent run completes; the run's
   trace exists in Langfuse; **a generation from the gateway arrives in Langfuse** (in its own
   trace, see the table) with usage and cost. If no gateway generation arrives, the OTLP export
   is not being accepted: model calls are unaffected, the gateway's log says why
   (`Langfuse export … failed`), and the fix or the rollback can wait for working hours.
7. **Afterwards.** Remove the one-off Job (`kubectl -n agentic-os delete job
   litellm-premigrate-<tag>`). Keep the pre-upgrade dump until the next clean week.

### Rollback

- **Image only — tested.** Revert the chart change (dependency and `litellm.image`), run
  `helm dependency build`, deploy. 1.90.0 runs on the 1.108.12 schema: keys, spend, teams and
  stored models were read and written without a schema error after the new version had been
  writing to the database. This is the normal rollback and loses nothing.
- **Database restore — tested.** Only if the data itself is suspect: scale the gateway to 0,
  restore the `litellm` database from the pre-upgrade dump (docs/backups.md), deploy the old
  chart. Everything the gateway wrote since the dump is lost: spend counted, keys created or
  changed — including system keys Build created in between, which the OS would then hold
  without a gateway counterpart (Rebuild re-creates them).
- The migration itself is not reversed by either path and does not need to be.

## 2. The gateway's own keys: salt key and master key

Full analysis: `docs/ops/litellm-salt-key.md` where present (it ships with the content-hygiene
change). The essentials, measured on 1.90.0 **and** 1.108.12:

- With no `LITELLM_SALT_KEY`, the **master key** encrypts the credentials of models stored in
  the database. Rotating it alone makes them undecryptable; they disappear from the model list
  without an error. LiteLLM's own rotation endpoint is an Enterprise feature.
- **Pinning `LITELLM_SALT_KEY` to the current master key value first makes a later master-key
  rotation safe:** nothing is re-encrypted, stored models keep working, and from then on the
  master key can change freely (tested: master key rotated, salt pinned → stored model served,
  old master key answers 401, virtual keys unaffected).
- A **new random** salt key on a database that already holds encrypted values loses them
  (tested: `400 Invalid model name`). Use one only together with re-creating those values.
- Virtual keys are stored as SHA-256 hashes of the key and depend on neither key.
- After the salt key is set it must never change.

## 3. Rotating every platform secret on an install that was deployed with chart defaults

**The situation.** The chart renders its credentials from literals in `values.yaml` when
`global.profile` is `local`. They exist so that a clone-and-run install works on a laptop.
An install that other people can reach and that still carries them has credentials anyone can
read in the public repository. Production runs `global.profile: local`.

**This section changes nothing.** It is the ordered procedure, to be rehearsed on a restored
copy first, and approved before anyone runs it. Values are never read from git and never
printed; where a step says "new value" it means one generated on the operator's machine
(`openssl rand -base64 36`) or, once the chart supports it, by the chart itself (3.4).

### 3.1 Inventory, by what a rotation touches

`helm template` of the default profile renders these Secrets (names and keys only). "Coupling"
is what else must change at the same moment.

| Secret → key | Used by | Coupling | Class |
|---|---|---|---|
| `os-ui-session` → `OS_SESSION_SECRET` | os-ui session cookie; MCP tokens when `OS_MCP_TOKEN_SECRET` is unset | none | **in place** — everyone is signed out, issued MCP tokens stop working. Already generated per install by the chart (`lookup` + `randAlphaNum`); listed for completeness |
| `agent-runtime-token` → `token` | os-ui and the in-cluster callers that present it (scheduled agent runs) | both sides read the same Secret | **in place**, restart both together |
| `litellm-credentials` → `UI_USERNAME`, `UI_PASSWORD` | LiteLLM console login; os-ui's server-side sign-in | none | **in place**, restart gateway then os-ui |
| `litellm-credentials` → `masterkey` | LiteLLM admin API; os-ui (admin reads/writes, Build); key-init Job | **encrypts database-stored model credentials while no salt key is set** | **stored data** — section 2 |
| `agent-litellm-key` → `apiKey` | every model call without a system key (os-ui, worker) | the key exists in LiteLLM's database under the alias `sovereign-agents` | **coordinated with the gateway** — 3.2 step 6 |
| per-system keys `sk-os-<id>` | a system's runs | derivable from the system id | replaced by random keys by the system-keys change; not rotated by hand |
| `langfuse-init` → project public/secret key; the same pair in `litellm-credentials` (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) and in os-ui | trace ingest and reads | stored hashed in Langfuse, with `salt` | **overlap possible**: create a second key pair in Langfuse, switch the clients, delete the old pair |
| `langfuse-init` → init user password | Langfuse admin login; os-ui's server-side sign-in | the init values are applied when the user is first created | change it **in Langfuse**, then update the Secret so os-ui signs in again |
| `langfuse-core-secrets` → `nextauthSecret` | Langfuse sessions | none | **in place** — Langfuse users are signed out |
| `langfuse-core-secrets` → `salt` | hashing of Langfuse API keys | every stored API-key hash | **stored data** — all project keys must be re-created afterwards; do it together with the project-key rotation |
| `langfuse-core-secrets` → `encryptionKey` | encryption at rest of secrets stored inside Langfuse (LLM connections, integration credentials) | everything encrypted with it | **stored data** — delete those entries before, re-enter them after. None are used by the OS today; confirm in the Langfuse settings before rotating |
| `postgres-<app>-credentials` (`langfuse`, `litellm`, `dagster`, `polaris`, `agent-runs`) → `password` | each application's database role | the role's password **inside Postgres** | **coordinated database change** — 3.2 step 3 |
| the Postgres bootstrap/owner credential | the reconcile that creates roles and databases; pg dump | the superuser password inside Postgres | **coordinated database change**, last of the database steps |
| `clickhouse-credentials` → `password` | Langfuse → ClickHouse | the ClickHouse user | **coordinated**, restart ClickHouse and Langfuse together |
| `valkey-credentials` → `password` | Langfuse (queue, cache), LiteLLM (response cache) | Valkey's `requirepass` | **coordinated**, restart Valkey and its clients together; Langfuse jobs queued in memory at that moment are lost |
| `object-storage-credentials` → access key, secret key | Langfuse blobs, the lakehouse, os-ui uploads | the object store's own credentials | **coordinated**; on managed object storage rotate at the provider and update the Secret |
| `polaris-credentials`, `trino-catalog-credentials` | Polaris bootstrap principal; Trino → Polaris OAuth | stored hashed in Polaris' database at bootstrap | **coordinated**, through Polaris' credential-rotation API, then Trino's Secret |
| `litellm-credentials` → `STACKIT_API_KEY` | the model provider | the provider | not a chart default; rotate at the provider on its own schedule |

Not secrets although they sit in the same objects: `LANGFUSE_HOST`, `STACKIT_API_BASE`, the
Langfuse org/project ids and names, database user names.

How each component picks a changed value up (ClickHouse, Valkey, the object store, Polaris, and
whether Langfuse's headless init re-creates anything) is **read from the chart and upstream
documentation, not tested**. Step 0 exists to find out before production does.

### 3.2 Order

0. **Rehearse on a copy.** Restore last night's backup into a scratch namespace or a local
   kind cluster (docs/backups.md), run every step below there, and write down what each
   component did. Take a fresh `deploy/pre-upgrade-backup.sh` in production immediately before
   starting, and announce a maintenance window: several steps restart the gateway or Langfuse.
1. **Close the front doors first** (the no-public-route change): with no public route to
   LiteLLM and Langfuse, the published credentials are usable only from inside the cluster
   while the rotation is in progress.
2. **In-place secrets**: `agent-runtime-token`, LiteLLM `UI_PASSWORD`, Langfuse
   `nextauthSecret`. For each: write the new value into the Secret, restart its readers,
   check the one thing it gates (a scheduled run, Admin → LLM Gateway, a Langfuse sign-in).
   *Rollback: put the previous value back, restart.*
3. **Database role passwords**, one application at a time. Postgres accepts the new password
   only after `ALTER ROLE`, the application sends the new one only after a restart, so the two
   must change within one step:
   1. write the new password into `postgres-<app>-credentials`;
   2. run the chart's role reconcile (it issues `ALTER ROLE "<role>" WITH LOGIN PASSWORD …`
      from those Secrets — `templates/base/postgres/`), or issue the same statement by hand as
      the superuser;
   3. restart the application's pods; check it connects.
   Between ii and iii the running pods keep their open connections; new connections fail until
   the restart. Do the bootstrap/owner credential last, and re-run the pg dump afterwards to
   prove the backup job still authenticates.
   *Rollback: `ALTER ROLE` back to the previous password, restore the Secret, restart.*
4. **Valkey, ClickHouse, object storage**: for each, new value into the Secret, restart the
   store and its clients in the same step (store first). Check Langfuse ingests a trace and
   LiteLLM's `/cache/ping` answers. *Rollback: previous value, same restarts.*
5. **LiteLLM master key and salt key.** Inventory the database-stored models first
   (`GET /model/info`, `db_model: true`) and the stored credentials and MCP servers.
   - **None stored** (expected: the chart defines every model): set a new random
     `LITELLM_SALT_KEY` and the new `masterkey` together, restart the gateway, restart os-ui.
   - **Some stored**: pin first. Set `LITELLM_SALT_KEY` to the current master key value,
     restart, rotate `masterkey`, restart — the stored models keep working throughout (section
     2). But the current master key is a published value, so that pin keeps a known key as the
     encryption key: finish by re-creating the stored models under a new random salt
     (`litellm-salt-key.md`, procedure C) and rotating the provider credentials they held.
   The console session is signed with the master key: everyone is signed out once.
   *Rollback: previous `masterkey`, remove or restore `LITELLM_SALT_KEY`, restart — valid
   only until models have been re-created under a new salt.*
6. **The shared agent key.** A virtual key cannot be changed in place, and LiteLLM refuses a
   second key with an alias that is in use (tested). So, in one short window: delete the key
   `sovereign-agents` in LiteLLM (`POST /key/delete` with `key_aliases`), write the new value
   into `agent-litellm-key`, delete the finished `litellm-agent-key-init` Job and let the next
   deploy (or a manual run of that Job) create the key again with the chart's caps, restart
   os-ui and the worker. Between the delete and the restart every call on the shared key is
   refused with 401 — the OS reports that as a rejected key and does not fall back to anything.
   The key's spend counter starts at 0; the spend log keeps the history.
   *Rollback: none for the deleted key itself; create it again with any value.*
7. **Langfuse project keys, then `salt` and `encryptionKey`.**
   1. Create a second API key pair for the project in Langfuse; put it into
      `litellm-credentials` and os-ui's Langfuse keys; restart gateway, os-ui and worker; check
      a trace arrives; delete the old pair in Langfuse. No gap.
   2. Change the init user's password in Langfuse, then the Secret; check Admin can still read
      traces through the OS.
   3. `encryptionKey`: remove any LLM connection or integration secret stored in Langfuse,
      set the new key, restart Langfuse, re-enter them.
   4. `salt`: set the new value and restart Langfuse — **every API key hash is now invalid**,
      so immediately create a new project key pair (as in i) and switch the clients. Traces sent
      in between are rejected; the OS and the gateway drop them without failing a run.
   *Rollback: `nextauthSecret`, `encryptionKey` and `salt` are reversible by restoring the
   previous value as long as nothing new was stored under the new one.*
8. **Polaris and Trino**: rotate the Polaris principal through its API, update
   `trino-catalog-credentials`, restart Trino; check a governed query.
9. **Afterwards**: run a full pass of the OS (an agent run, a query, a file upload, a dashboard),
   take a new backup, and treat every rotated credential as burnt — including in old backups,
   which still contain the default values and the data they protected.

### 3.3 Leaving `global.profile: local`

The profile is what makes the chart render Secrets from literals. A real deployment needs
them not to exist. Two ways, in order of preference:

1. **Stop the chart from shipping usable defaults at all** (3.4), so the profile no longer
   decides whether an install is safe. The laptop install then generates its own values once
   and works exactly as before.
2. Until then, move the production release to its own profile: provide every Secret in the
   inventory yourself (External Secrets, or `kubectl create secret` before the upgrade),
   switch `global.profile`, and confirm with `helm template … | grep -c 'kind: Secret'` that
   the chart no longer renders the default ones. Do the rotation first: switching the profile
   while the cluster still depends on chart-rendered Secrets deletes them.

### 3.4 What the chart and the components should do (proposal, not implemented here)

- **Generate, do not ship.** Every chart-owned credential follows the pattern
  `templates/base/os-ui/os-ui-session.yaml` already uses: an explicit value from the operator
  (or an ExternalSecret) wins; otherwise the value already in the cluster is kept (`lookup`);
  otherwise a random one is generated at first install (`randAlphaNum`), with
  `helm.sh/resource-policy: keep`. No usable literal remains in `values.yaml`. The same
  GitOps caveat applies as there: a renderer without cluster access cannot `lookup`, so those
  pipelines must supply the values.
- **Refuse known defaults at boot.** os-ui already refuses to start in production with the
  placeholder session secret (`assertNoDevDefaultSecretsInProd`) and refuses to honour the
  placeholder runtime bearer. Extend the same guard to every default it can see: the LiteLLM
  master key, the shared agent key, the Langfuse keys and the LiteLLM UI password. Give the
  key-init Job the same check (refuse to register a known default key value), and make the
  chart `fail` when a default literal would be rendered while `ingress.enabled` is true — the
  one unambiguous signal that an install is not a laptop.
- **A check in the gate**, next to the other chart checks: render the STACKIT profile and fail
  if any Secret value equals a literal from `values.yaml`.

Each of these is a change of its own with its own tests; none is part of the gateway upgrade.
