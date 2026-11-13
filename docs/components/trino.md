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
   `TRINO_ACCESS_RULES=true`, which the chart sets with `trino.accessControl.enabled`). At boot,
   os-ui enumerates domains and users (`tabs/admin/lib/users.ts`) and PATCHes the same ConfigMap
   key. Trino re-reads the file within `security.refresh-period` (default 30 s) — **no pod restart,
   no roll**. The volume is mounted as a directory, not a `subPath`, because only a whole-ConfigMap
   volume is refreshed by the kubelet.

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

Making impersonation load-bearing needs, on the cluster: `http-server.authentication.type=PASSWORD`
(or `JWT`/`OAUTH2`), a password authenticator with a credential for `dbt-runner` and for the OS's
query path, `TRINO_PASSWORD` in the Dagster run pod and the query-tool, and `http_scheme=https` or
`http-server.authentication.allow-insecure-over-http=true` for a local cluster. That is a deploy
decision with a new secret in it, so it is written here rather than guessed at.

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

## FAQ

**Can a user run arbitrary SQL?** Reads: yes, through `query_data` / the Data tab, and Trino→OPA
governs every row and column — `guard_read` in the query-tool additionally refuses anything that is
not a single read-only statement. Writes: no free-text path. `/execute` accepts only the statement
shapes `execute_guard.py` allowlists, and with the data-project flag on the writes are dbt models
the OS generated from structured specs.

**Why does a build read as the builder and not as a service account?** Because a CTAS contains
reads, and a build that could read more than its author would be a privilege escalation with extra
steps. `connect_kwargs` in the query-tool is factored out and unit-tested for exactly this
invariant: the session user is the caller's principal, never the tool's identity.

**Resource groups?** `trino.resourceGroups` renders a static file manager with one subgroup per
domain plus `shared`, selected by the `domain=<name>` client tag.

## Licences

Trino: Apache-2.0. The Trino→OPA access-control plugin ships with Trino. `dbt-trino`, `dagster-dbt`,
dbt Core, Dagster: Apache-2.0. See `THIRD-PARTY-LICENSES.md`.
