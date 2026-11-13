# Trino — the engine every data product executes on, as the acting principal

**What it is:** Apache Trino (Apache-2.0), one coordinator-as-worker pod, Iceberg connector against
the Polaris REST catalog, object storage underneath (MinIO locally, STACKIT Object Storage on
STACKIT). Every read and every write of a governed mart goes through it. There is no second door:
no embedded DuckDB on a governed table, no direct object-store read from the UI.

Chart: `charts/sovereign-agentic-os/templates/extensions/lakehouse/trino.yaml`, values `trino.*`.

## The one rule: Trino's session user IS the OS principal

Nothing in this stack queries Trino as a shared service identity. Every path sets the Trino session
user to the identity the OS resolved server-side from the signed session, so Trino's own governance
— the OPA plugin's row filters, column masks and the hard deny on a foreign `personal_*` schema —
applies to the acting person, not to a proxy.

### Who runs as whom

| Path | Code | Connects as | Trino session user (the governed identity) |
|---|---|---|---|
| OS read: `query_data`, dataset preview, profile, DQ probe, metric explore, catalog | `core/infra/governed.ts` `queryRun` → query-tool `/query` | the service bearer (os-ui → query-tool) | `readPrincipalFor(sql, user)` — the caller's **first domain**, flipped to the caller's **uid** when the SQL touches their own `personal_<uid>` lane (even the owner is denied their own personal table under a domain principal) |
| OS write: Silver / Gold CTAS, publish, sync slices | `core/infra/governed.ts` `executeRun` → query-tool `/execute` | the service bearer | `identity.principal` = `user.domains[0] ?? user.id`; `execute_guard.py` re-validates the statement allowlist and the role floor before Trino sees it |
| **dbt in a Dagster run pod** (engine rebuild B1–B3) | generated `profiles.yml` + `dbt-trino` | `user: {{ env_var('TRINO_USER', 'dbt-runner') }}` | **`impersonation_user: {{ env_var('OS_PRINCIPAL') }}`** — the schedule's principal, the maintenance schema's owner, or what the OS passed on an explicit launch, injected per run through the `dagster-k8s/config` run tag |
| **External-source observation** (engine rebuild B3) | `images/extensions/dagster/repo.py` `_trino_rows` | — | the source asset's `principal` from `os/sources.yml` (the dataset owner) |
| Dagster sensors (`os_quarantine`, `os_principals`) | `repo.py` | — | **never touch Trino**: they read the Dagster instance and the OS repo index (runtime bearer) |
| repo-sync sidecar | `repo-sync.sh` → `os_projects.dbt_parse` | — | **never touches Trino**: `dbt parse` renders the repo under an allowlisted environment with `OS_PRINCIPAL=repo-sync` as a render-only placeholder |

`profiles.yml` contains **no credential value** — only `env_var()` calls. The run pod's environment
supplies them; the repository is readable by anyone who can clone it.

## Access control: TWO chained system access controls

Trino accepts a list of system access controls and **every one of them must allow**, so adding a
second can only narrow the policy. With `trino.accessControl.enabled` (default **true**) the chart
writes:

```properties
# trino-config → config.properties
access-control.config-files=/etc/trino/access-control-opa.properties,/etc/trino/access-control-file.properties
```

| File | What it decides | Where it comes from |
|---|---|---|
| `access-control-opa.properties` | `access-control.name=opa` — row filters by domain, column masks by sensitivity, the foreign `personal_*` deny | `policies/trino.rego`, the same OPA that governs agent tools |
| `access-control-file.properties` | `access-control.name=file`, `security.config-file=/etc/trino/access-rules/rules.json` — **impersonation** and **schema ownership**, the two things the OPA plugin cannot express | `rules.json` (below) |

### `rules.json` — generated, never hand-written

One shape, two renderers, one test that keeps them equal
(`core/infra/trino-rules.test.ts` → "the chart bootstrap IS this generator…"):

1. **The chart's bootstrap** (ConfigMap `trino-access-rules`, rendered by Helm). It bounds
   impersonation by the SHAPE of an OS id and leaves ownership exactly as it is without the file —
   `{"owner": true}`, full privileges. Closing ownership here would deny every CTAS the OS already
   runs on a fresh install, before the OS has said anything about membership.
2. **The OS's reconciled file** (`core/infra/trino-rules-server.ts`, enabled by
   `TRINO_ACCESS_RULES=true`). os-ui enumerates domains and users (`tabs/admin/lib/users.ts`) and
   PATCHes the same ConfigMap key. Trino re-reads the file within `security.refresh-period`
   (default 30 s) — **no pod restart, no roll**. The volume is mounted as a directory, not a
   `subPath`, because only a whole-ConfigMap volume is refreshed by the kubelet.

   **When the env var is set, exactly.** `TRINO_ACCESS_RULES` renders under
   `trino.enabled AND trino.accessControl.enabled AND trino.opa.enabled` — character for character
   the gate the `trino-access-rules` ConfigMap itself renders under. It is deliberately **not** gated
   on `osUI.dataProjectGit`: the two flags are independent (B4 turned `dataProjectGit` on by
   default, but an operator may still opt out of it for a release, and the schema-ownership rules
   must keep applying), an install with access control off used to log "ConfigMap does not exist" on
   every boot (L-5), and before the gates were aligned a default install shipped the permissive
   bootstrap with nothing ever reconciling it (review B3-review-H-1).
   `scripts/check-trino-rules-chart.mjs` renders four value sets and asserts the two gates agree.

   **Three triggers** (`startTrinoRulesReconciler`, review B3-review-H-2/H-3):

   | Trigger | When | Why it exists |
   |---|---|---|
   | boot | once, as the process starts | the bootstrap file is open until the first pass lands |
   | event | every user / domain / membership write | the kernel `directory-changed` event (`core/kernel/events.ts`) that `tabs/admin/lib/{users,domains}.ts` emit from their one write-through; debounced (2 s) and serialised, so a bulk import is ONE reconcile |
   | periodic | every `trino.accessControl.reconcileIntervalMinutes` (default 10), jittered | **`helm upgrade` rewrites Helm's bootstrap value over the OS's enumerated file** and emits no OS event. This pass is a GET plus a byte compare when nothing drifted. |

   A write path never imports the reconciler and `core/` never imports a tab: the stores emit, and
   `instrumentation.ts` is the only subscriber.

   **When it fails** the reconciler retries 3× with exponential backoff (capped at 30 s), records a
   typed outcome (`ok`/`code`/`detail`/`at`) and publishes it on **Platform → Components & Health**
   as the `Trino access rules` row — red when the last attempt failed, and red when the last
   SUCCESS is older than twice the repair interval (the loop itself is gone). A failed reconcile is
   not cosmetic: it means the permissive bootstrap is what Trino is enforcing.

What the enumerated file says (`core/infra/trino-rules.ts` `buildTrinoRules`, first match wins):

```
impersonation:
  dbt-runner → ^(amir|bea|cleo|finance|sales)$   allow      # exactly the OS's principals
  dbt-runner → .*                                 DENY
  (.*)       → $1                                 allow      # anyone may be themselves
  .*         → .*                                 DENY       # and nobody else
schemas:
  (amir|bea|sales) → ^sales$          owner: true           # a domain schema: the domain + its members
  amir             → ^personal_amir$  owner: true           # a personal lane: its owner only
  <catch-all>                         owner: false
tables:
  (amir|bea|sales) on ^sales$          SELECT INSERT DELETE UPDATE OWNERSHIP
  anyone on ^sales$                    SELECT                 # row filters + masks stay OPA's job
  amir on ^personal_amir$              SELECT INSERT DELETE UPDATE OWNERSHIP
  anyone on ^personal_amir$            (none)                 # never re-open a foreign lane here
  <catch-all>                          SELECT
```

Properties the tests assert, not the comments:

- the dbt service user can become an OS principal and **nothing else** — not `root`, not `trino`,
  not `sales2`, not `admin; drop`, not a deactivated user;
- **no other user** can become another identity at all;
- a `finance` member cannot own the `sales` schema, and a personal lane has exactly one writer;
- the file is byte-stable (input order does not change it) and **carries no secret** — it is a
  ConfigMap, visible to anyone who can read it, and nothing but identifiers and regexes goes in.

Schema naming, for the avoidance of doubt: the OS's schemas are `personal_<uid>` and the
**sanitized domain name** (`store-fqn.ts` `domainSchema`) — there is no `<domain>_silver` /
`<domain>_gold` pair. Layers are table prefixes (`silver_orders`, `gold_order_customer`), not
schemas.

### What is NOT true yet (read this before trusting impersonation)

The chart does **not** set `http-server.authentication.type`, so **Trino does not authenticate
clients**. The session user is therefore *asserted* by the client, not proven — and an
`impersonation` rule distinguishes an authenticated `original_user` from a claimed `new_user`. Until
authentication is enabled, the rules file is a correct, tested, deployed **narrowing** that has
nothing to bite on for the impersonation section: what actually keeps the claim honest today is the
network boundary (NetworkPolicies, and the service bearer between os-ui and query-tool) plus the
fact that every principal is resolved server-side from the signed session and never from a request
body. The schema-ownership rules DO bite immediately, because they match on the session user.

### Enable real impersonation — the procedure

**This is a deploy decision with a new secret in it.** Nothing below is on by default and nothing
below is done by the OS; an operator does it, in this order. The generated `profiles.yml` is
already ready for it: it emits `password: "{{ env_var('TRINO_PASSWORD', '') }}"` inside a
`{% if env_var('TRINO_AUTH_METHOD', 'none') != 'none' %}` guard, so the key is simply absent under
`method: none` (which is what `TrinoNoneCredentials` requires) and present the moment you switch.
Only `env_var()` ever appears — a literal password in a repo anyone in the domain can clone is not
a path the generator offers.

1. **Pick an authenticator.** Add to the Trino coordinator's `config.properties`
   (`templates/extensions/lakehouse/trino.yaml`):
   `http-server.authentication.type=PASSWORD`, plus a `password-authenticator.properties`
   (`password-authenticator.name=file`, `file.password-file=/etc/trino/password.db`). `JWT` or
   `OAUTH2` work the same way for the rules file; PASSWORD is the smallest step.
2. **Allow it over the cluster-internal protocol.** Either terminate TLS on the coordinator
   (`http-server.https.*`) and set `TRINO_HTTP_SCHEME=https` everywhere, or — in-cluster only, with
   the NetworkPolicies in place — set
   `http-server.authentication.allow-insecure-over-http=true`. Trino refuses PASSWORD over plain
   HTTP without it.
3. **Create exactly two credentials** in a Kubernetes Secret (never in values.yaml, never in the
   repo): one for `trino.accessControl.serviceUser` (`dbt-runner`) and one for the OS's query path
   (the query-tool's `TRINO_USER`). Hash them into the password file with `htpasswd -B -C 10`.
4. **Mount them.** `TRINO_PASSWORD` from that Secret into (a) the Dagster **run pod** — add it to
   the code location's `env` in `values.yaml` so `includeConfigInLaunchedRuns` propagates it — and
   (b) the **query-tool** Deployment. Set `TRINO_AUTH_METHOD` from `none` to the matching
   dbt-trino method at the same time, in the same place.
5. **Check the user alignment first.** The run pod's `TRINO_USER` MUST equal
   `trino.accessControl.serviceUser`, because that is the only `original_user` the generated
   impersonation rule lets become an OS principal. A mismatch is invisible today (nothing
   authenticates) and a hard denial the second you finish step 1 — exactly the trap review
   B3-review-H-5 found, with `TRINO_USER: dbt-sales` against `serviceUser: dbt-runner`.
   `scripts/check-trino-rules-chart.mjs` now fails the gate on that mismatch.
6. **Verify.** `dbt-runner` must be able to become `sales` and must NOT be able to become `root`
   (see "Verify it in a cluster", step 4). Until step 1 is done, both succeed, because there is no
   `original_user` to match.

## Verify it in a cluster

```sh
# 1. The chained access controls are what Trino loaded.
kubectl -n agentic-os exec deploy/trino -- cat /etc/trino/config.properties | grep access-control
kubectl -n agentic-os exec deploy/trino -- cat /etc/trino/access-rules/rules.json | head -20

# 2. The OS reconciled the file (look for the boot line, then the ConfigMap).
kubectl -n agentic-os logs deploy/os-ui | grep 'trino access rules'
kubectl -n agentic-os get cm trino-access-rules -o jsonpath='{.data.rules\.json}' | python3 -m json.tool | head

# 3. A refresh really is picked up without a restart: patch the ConfigMap, wait
#    security.refresh-period, and watch the decision change — no pod age change.
kubectl -n agentic-os get pod -l app.kubernetes.io/component=trino -o wide

# 4. Impersonation, once authentication is on: dbt-runner may become `sales` and must NOT
#    become `root`.
#    (Without authentication both succeed, because there is no original_user to match — see above.)
```

## Known limits (follow-ups, not news)

- **A governed READ runs as the caller's first domain, not as the person.**
  `readPrincipalFor(sql, user)` resolves to `user.domains[0]` for anything outside the caller's own
  `personal_<uid>` lane. So two people in the same domain are indistinguishable to Trino on a
  domain-schema read, and a person in two domains reads as whichever one sorts first in their
  membership list. Row filters and column masks are therefore evaluated for the DOMAIN, not for the
  individual. This is pre-existing (it predates the engine rebuild) and it is a **follow-up**, not
  something B3 changed: making the read run as the uid needs per-user grants in `trino.rego` and a
  per-user Trino credential, which is the same deploy decision as the impersonation procedure
  above. The WRITE path has the same shape (`identity.principal = user.domains[0] ?? user.id`).
- The impersonation section of `rules.json` is inert until authentication is enabled (above).
- Column-level lineage is not derived from the manifest (deviation B3-6).

## If the rules were never reconciled

The chart installs a PERMISSIVE bootstrap `rules.json` so Trino starts; the OS replaces it from
real domain membership (`core/infra/trino-rules-server.ts`). Until the FIRST successful reconcile,
that bootstrap is the live file: impersonation is bounded only by the shape of a principal id, and
table ownership is OPEN. Such an install is governed by **OPA alone** — row filters and column
masks still apply, the file-based ownership layer does not (B4-review E-2).

This is visible, deliberately: Platform → Components & Health shows the `Trino access rules` row
**RED** (not amber) until the first success, with what is open and what to check. It used to be
amber, which read as a warm-up state — and a reconciler that never reaches the cluster stays in
exactly that state forever. Every failure code is retried, `no-cluster` and `no-configmap`
included, because at boot those are usually RBAC propagation and Helm's object ordering rather
than verdicts; the jittered periodic pass remains the long-horizon retry.

What to check when the row stays red: the os-ui Role grants `get` + `patch` on the
`trino-access-rules` ConfigMap (`resourceNames`-scoped), the ConfigMap exists, and
`trino.accessControl.enabled` + `trino.opa.enabled` are both on.

## FAQ

**Can a user run arbitrary SQL?** Reads: yes, through `query_data` / the Data tab, and Trino→OPA
governs every row and column — `guard_read` in the query-tool additionally refuses anything that is
not a single read-only statement. Writes: no free-text path. `/execute` accepts only the statement
shapes `execute_guard.py` allowlists, and the writes that matter are dbt models the OS generated
from structured specs. `/execute` itself is NOT gone (B4 kept it deliberately): besides the build
CTAS it carries `apply_quality_fixes`'s MERGE, physical deletes, the warehouse import, the
promote/publish CTAS and — the sixth path, missing from earlier revisions of this list
(B4-review L-6) — the **sync SLICE EXECUTOR**: with `DATA_PROJECT_GIT` off, and for any sync the
Dagster path does not cover, `tabs/data/lib/sync-run-server.ts` compiles one slice per run from
`sync-sql.ts` (a `delete`+`insert` for a cursor window, a `merge` for upsert keys, a full replace
for full-refresh) and sends it through `/execute` as the dataset OWNER, never a service principal.
That is why `execute_guard.py`'s allowlist includes those shapes and why the owner's identity is
resolved live (409 when it cannot be). Deleting the build CTAS specifically waits on the row-set
parity run in kind (checklist D15), because the honesty gate registers a version only after a real
apply+verify.

**Why does a build read as the builder and not as a service account?** Because a CTAS contains
reads, and a build that could read more than its author would be a privilege escalation with extra
steps. `connect_kwargs` in the query-tool is factored out and unit-tested for exactly this
invariant: the session user is the caller's principal, never the tool's identity.

**Resource groups?** `trino.resourceGroups` renders a static file manager with one subgroup per
domain plus `shared`, selected by the `domain=<name>` client tag.

## Licences

Trino: Apache-2.0. The Trino→OPA access-control plugin ships with Trino. `dbt-trino`, `dagster-dbt`,
dbt Core, Dagster: Apache-2.0. See `THIRD-PARTY-LICENSES.md`.
