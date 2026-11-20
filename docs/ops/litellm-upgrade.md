<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# LiteLLM gateway: upgrading, rolling back, and rotating its keys

For the operator. It replaces the 1.108.12 procedure of PR #104. Four parts: the upgrade to
1.109.1 with the switch to the `langfuse_otel` callback (10 F1, WP-32); the gateway's own keys;
the rotation of the platform secrets; and the gateway's own Langfuse key pair. **Parts 3 and 4
are procedures for the owner. Nothing in them has been executed.**

## 1. Upgrading the gateway to 1.109.1 with `langfuse_otel`

Why 1.109.1 and what it is pinned as: `components/litellm/UPSTREAM.md`.

### What changes for this deployment

Measured with `scripts/tests/litellm-langfuse/run.sh` and `upgrade.sh` (real images, the chart's
rendered config and env), unless a line says "PR #104" (measured there on 1.108.12, the behaviour
the 1.109 line inherits) or "release notes".

| Area | 1.90.0 (live) | 1.109.1 | Consequence here |
|---|---|---|---|
| Advisories | affected by GHSA-3cv6-jpf6-8222, GHSA-g5ff-637f-6q2m, GHSA-w4c7-34wj-hqm8, GHSA-2rwg-2wh4-7c4f | all four fixed | one reason for the upgrade |
| Langfuse callback | legacy `success_callback: ["langfuse"]` | `callbacks: ["langfuse_otel"]` on OTel v2 (`LITELLM_OTEL_V2=true`) | Langfuse v4 rejects the legacy one (10 F1). Both together: **two generations per call** (measured: the negative twin) |
| Nesting | body `existing_trace_id` / `parent_observation_id` | W3C `traceparent` header; call id from `x-litellm-call-id` | os-ui sends the headers (`core/runtime/gateway-trace.ts`). Until run ids are W3C ids (05 step 2), the gateway's generation sits in its own trace, linked to the OS generation by `litellm_call_id` |
| Span scope | — | `full` nests but exports background polls (0.667/s idle, no setting excludes them); `llm_only` re-roots the generation in the same trace | `llm_only` chosen, joined by call id; `full` returns with WP-05's collector filter (`components/litellm/UPSTREAM.md` "Span scope") |
| Generation | `litellm:<key alias>`, usage + cost | `chat <model>`, usage + cost (`calculatedTotalCost` from `model_info`), user, session and tags from the request metadata | rename any Langfuse filter on the old name |
| Message content in Langfuse | redacted by `turn_off_message_logging`; tool-call arguments masked by `mask_output` | not captured at all (V2 default); no prompt or completion text in any gateway observation (measured) | `mask_output` is ignored on V2 and kept only for a rollback to 1.90 |
| `x-langfuse-ingestion-version: 4` | — | sent by the exporter (measured) | nothing to configure for v4 |
| Version on `/health/readiness` | — | gone; `/health/readiness/details` (admin key) reports `litellm_version` and the loaded callbacks | the post-check uses `/details` |
| Database schema | old | new migrations | **the new proxy on the old schema reports ready and refuses every call** (`401 … column t.tpd_limit does not exist`); the old proxy runs on the new schema (measured). Migrate first — step 4 |
| Spent budget | 429 `budget_exceeded` | refused (`budget_exceeded`) | `isBudgetRejection` accepts 400, 422 and 429 forms; measured: os-ui raises `BudgetExceededError` |
| Router fallback to a model not on the key's list | served | refused (PR #104, 1.108) | `check-litellm-allowlist.mjs` already requires every fallback target on the shared key |
| Error wording for "model not allowed", "invalid key" | — | changed, `type` unchanged (PR #104) | match on `type` |
| `/key/info` for a deleted key | 404 | 200 with the old record (PR #104) | use `/key/list?key_alias=` |
| Config vs database precedence | database wins | config file wins (release notes, 1.103) | the chart's values win after every deploy |
| Fallback targets as strings | accepted | must be lists (release notes, 1.109.0) | the chart already uses lists |
| `cache_params.type: disk` | supported | removed (release notes, 1.109.0) | the chart uses `redis` |
| Helm subchart | `litellm-helm` 1.90.0 | 1.109.1; migration Job gains `activeDeadlineSeconds: 1800` and an empty `securityContext` | rendered Deployment, Job and ConfigMap otherwise unchanged apart from the image and the new env (diffed) |

### Procedure

1. **Rehearse.** `helm dependency build charts/sovereign-agentic-os`, then
   `scripts/tests/litellm-langfuse/run.sh`. It ends with `LITELLM_LANGFUSE_TEST_OK`. It runs the
   chart's own gateway image, config and OTel env against Langfuse 3.194.1, and its negative twin
   (the legacy callback added) must fail. Do not continue on a failure.
2. **Pre-checks** (read-only):
   - The os-ui you deploy is from the same commit: it sends `traceparent` / `x-litellm-call-id`
     and reads a 422 as a spent budget.
   - Langfuse answers on the OTLP endpoint: `/api/public/health` reports 3.63 or newer
     (production: 3.194.1).
   - The live release's values add no legacy callback. Only key names are printed:
     `helm --kube-context dmagenticos -n agentic-os get values agentic-os -o json | jq '.litellm.proxy_config.litellm_settings // {} | keys'`.
     If `success_callback` is listed, remove it from the values you deploy with, or the gateway
     logs every call twice (the gate check covers the files in git, not the live values).
   - No long agent run is in flight.
3. **Back up.** `export KUBECONFIG=~/.kube/config && deploy/pre-upgrade-backup.sh` (pg dump of
   every database plus the Velero backup of the namespace; it aborts if either fails). The next
   step already changes the database.
4. **Migrate first.** `deploy/litellm-premigrate.sh --dry-run`, read what it would create (image
   `…litellm-database:1.109.1@sha256:932c…`, the migration command, database host `pg-rw`), then
   `deploy/litellm-premigrate.sh`. It renders the chart's own migration Job for the live release,
   runs it under its own name and waits up to 45 minutes. The 1.90.0 proxy keeps serving on the
   migrated schema (measured, `scripts/tests/litellm-langfuse/upgrade.sh`). On `PREMIGRATE_FAILED` nothing was upgraded: read the
   log and stop.
5. **Upgrade.** `./scripts/deploy.sh --from-registry <os-ui version>`. The chart's own migration
   Job finds nothing left to do; the proxy pod is replaced; the key-init Job reconciles the
   shared key.
6. **Post-checks** (read-only, except the port-forward, which the coordinator runs):
   ```bash
   kubectl --context dmagenticos -n agentic-os get deploy agentic-os-litellm \
     -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'          # …litellm-database:1.109.1@sha256:932c…
   kubectl --context dmagenticos -n agentic-os get pods -l app.kubernetes.io/name=litellm   # Running, 0 restarts
   kubectl --context dmagenticos -n agentic-os get cm agentic-os-litellm-config -o jsonpath='{.data.config\.yaml}' \
     | grep -nE 'callbacks|success_callback|failure_callback'                    # only: callbacks: - langfuse_otel
   kubectl --context dmagenticos -n agentic-os get deploy agentic-os-litellm \
     -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' | grep LITELLM_OTEL
   kubectl --context dmagenticos -n agentic-os logs deploy/agentic-os-litellm --since=10m | grep -iE 'otel|langfuse' | grep -iE 'error|fail|40[134]'   # nothing
   kubectl --context dmagenticos -n agentic-os port-forward svc/agentic-os-litellm 4000:4000 &
   # $MASTER from the litellm-credentials Secret, read into the shell without printing it
   curl -s -H "Authorization: Bearer $MASTER" localhost:4000/health/readiness/details \
     | jq '{status, litellm_version, langfuse: [.success_callbacks[] | select(test("angfuse"))]}'
   # expected: "litellm_version": "1.109.1", "langfuse": ["LangfuseContentOpenTelemetryV2"] (no LangfusePromptManagement)
   ```
   Then in the OS: a short agent run completes. In Langfuse (port-forward to `agentic-os-langfuse-web`):
   exactly one gateway generation per model call, named `chat <model>`, with usage and cost, and
   `metadata` carrying the call id the OS generation records as `litellm_call_id`. Until run ids
   are W3C ids (05 step 2, WP-31) that generation is in its own trace, not inside the run's.
7. **Span scope after the deploy** (10 minutes, read-only). The chart ships `llm_only`: one
   generation per call, in the run's trace, joined to the OS's `llm.<node>` span by the call id,
   and none of LiteLLM's background work (`components/litellm/UPSTREAM.md` "Span scope"). Confirm
   the background rate on the live system:
   ```bash
   kubectl --context dmagenticos -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000 &
   # LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY read into the shell without printing them
   LANGFUSE_URL=http://127.0.0.1:3000 deploy/langfuse-idle-rate.sh 10
   ```
   - **Expected: ≤ 0.2 per second (exit 0).** In the test rig it is 0.
   - Exit 3 under `llm_only` means something other than the gateway sends untagged traces. Find the
     sender (trace names in Langfuse); do not change the scope for it.
   - **The two paths.**
     - *Now:* `llm_only`. Langfuse does not draw the generation under the `model-call` span, but it
       sits in the same trace and is matched by `litellm_call_id`. Run diagnostics use that join.
     - *With WP-05:* `full`, with an OTel Collector `filter` processor between LiteLLM and Langfuse
       that drops LiteLLM's datastore spans. Only then does Langfuse show the generation nested.
       The exact steps are in `components/litellm/UPSTREAM.md` "What WP-05 must do". Both e2e
       tests read the scope and switch their assertions by themselves.
   - **Do not** reduce the volume with an OTel sampler (`OTEL_TRACES_SAMPLER=parentbased_always_off`
     or similar). It drops spans by trace, which drops generations too.
8. **Afterwards.** `kubectl -n agentic-os delete job litellm-premigrate-<tag>`. Keep the dump until
   the next clean week.

### Rollback

- **Image and config together — the normal rollback.** Revert this change (chart dependency,
  `litellm.image`, the callback and the `LITELLM_OTEL_*` env, and the os-ui of the same commit),
  `helm dependency build`, deploy. 1.90.0 runs on the 1.109.1 schema (measured: chat 200, the key
  and its spend intact, no schema errors). Valid **only while Langfuse is on v3**: v4 rejects the
  legacy callback (WP-33 gates on this change being live). After a rollback, the gateway's legacy
  generations start their own trace per call (the os-ui no longer sends `existing_trace_id`) and
  still carry usage, cost and `mask_output`.
- **Config only.** Not supported: 1.109.1 with the legacy callback alone gives up the v4 path, and
  with both callbacks every call is logged twice (the gate refuses that config).
- **Database restore.** Only if the data itself is suspect: scale the gateway to 0, restore the
  `litellm` database from the pre-upgrade dump (docs/backups.md), deploy the old chart.
  Everything the gateway wrote since the dump is lost (spend, keys created or changed).
- The migration itself is not reversed by any path and does not need to be.

## 2. The gateway's own keys: salt key and master key

Full analysis: `docs/ops/litellm-salt-key.md` where present (it ships with the content-hygiene
change). The essentials, measured on 1.90.0 **and** 1.108.12 (PR #104); the encryption code path is unchanged in 1.109.1 according to its release notes, but it was not re-measured:

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


## 3. Rotating the platform secrets (procedure for the owner; nothing here is executed)

The chart renders its credentials from literals in `values.yaml` when `global.profile` is `local`, so that a clone-and-run install works on a laptop. An install that other people can reach should run with credentials of its own. This section is the ordered procedure for replacing them. **It changes nothing by itself**: it is rehearsed on a restored copy first and approved and run by the owner. Values are never read from git and never printed; where a step says "new value" it means one generated on the operator's machine (`openssl rand -base64 36`) or, once the chart supports it, by the chart itself (3.4).

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


## 4. The gateway's own Langfuse key pair (05 §5.4; procedure for the owner, not executed)

Today the gateway sends with the same Langfuse project key pair as os-ui. 05 §5.4 gives it a pair
of its own (`gateway`), so that rotating one does not break the other and ingestion can be told
apart. Langfuse OSS creates a second project key only in its UI (the organisation and project
management API is an Enterprise feature), so this is a manual step:

1. Langfuse UI (port-forward to `agentic-os-langfuse-web`) → project `agent-core` → Settings →
   API keys → create a key pair, note "gateway".
2. Put it into the Secret the gateway reads (`litellm-credentials`, keys `LANGFUSE_PUBLIC_KEY`
   and `LANGFUSE_SECRET_KEY`) through the same channel that manages that Secret today. Do not
   print the values.
3. `kubectl -n agentic-os rollout restart deploy/agentic-os-litellm`; check that a model call
   still arrives in Langfuse as one generation (post-check in 1.6).
4. Nothing else uses that pair until step 5 of 05 (os-ui keeps the init pair). Rollback: put the
   previous values back and restart.
