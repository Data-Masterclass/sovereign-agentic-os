<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Per-person database permissions: queries run as the acting user (WP-35)

**Status:** design for review, 24 Nov 2026. No code yet. The owner approved the goal.
**Depends on:** PR #335 (ungoverned domain tables floor) and PR #333 (Company scope). Both are open.
**Relates to:** `docs/components/trino-cutover.md` (WP-14, impersonation), `docs/components/trino.md`.

## Summary

Today almost every Trino read made for a person runs as their **domain**. The Trino session user
is `user.domains[0]`, so OPA sees "sales", not "anna". Because of this, the per-person parts of
the policy never match: a dataset shared with named people (`shared_with_users`) and per-person
clearances are compiled and pushed, but the session user is a domain name, so they are never
checked. Row filters only work per domain. Trino already has the mechanism we need. Since WP-14,
the query-tool logs in as the service user `svc-os-ui` and *impersonates* a session user, and OPA
decides `ImpersonateUser`. The change is to set the session user to the **person's uid** on every
path that acts for a person. That covers people in the UI, MCP, chat-to-data, and agents acting
for the person who invoked them. The domain self-principals are kept only for the few system paths
that really act for a domain, behind an explicit list. The Rego barely changes: it already decides
on the session user and their roster domains. Most of the work is roughly 25 call sites in os-ui,
one rule in `trino_impersonation.rego`, the compiler's principal set, and the proof that nothing
reads fewer or more rows than intended.

## 1. Current state (evidence)

| What | Where | What it does today |
|---|---|---|
| Query tool picks the session user | `os-ui/tabs/data/mcp/data-query-tools.ts:62-67` | `domainPrincipal = user.domains[0] ?? user.id`. The Trino user is `readPrincipalFor(sql, user)`, which flips to the uid **only** when the SQL names the caller's own `personal_<uid>` schema |
| The flip rule | `os-ui/tabs/data/lib/store-fqn.ts:166-172` | regex on the SQL text: own lane gives `user.id`, everything else gives `user.domains[0]` |
| Other read paths | `store-fqn.ts:316,330,339,356`, `adopt-connected.ts:158`, `physical-delete.ts:180`, `reconcile.ts:105`, `discovery-read-tools.ts:135`, `exposure-propagation.ts:65` | the same `domains[0]` pattern, copied |
| Write identity | `os-ui/tabs/data/lib/mutations-server.ts:119`, `tabs/connections/lib/store.ts:1305` | `{ principal: user.domains[0] ?? user.id, uid, domains, role }`. The query-tool's `execute_guard.py` checks uid and role; Trino sees the domain |
| Transport | `os-ui/core/infra/governed.ts:149-165` | `queryRun(sql, principal, route)` posts `principal` to the query-tool `/query` |
| Query-tool connect | `images/extensions/query-tool/app.py:109-140`, `trino_login.py:41-48` | session user = the principal os-ui sent. Login = `svc-os-ui` (Basic auth over TLS) when `TRINO_AUTH_USER` is set, so Trino asks OPA `ImpersonateUser` |
| Who `svc-os-ui` may impersonate | `charts/sovereign-agentic-os/policies/trino_impersonation.rego:101-114` | an active OS user **or any key of `data.governance.principals`**. The comment calls this "INTERIM until WP-35", because domain names are keys there |
| Domain self-principals | `os-ui/tabs/data/lib/policy/compiler.ts:87-100` | every domain is emitted as a principal `{domains:[d]}`. The comment says it is "load-bearing" because "the governed query tool runs as the domain name" |
| Per-person entitlement | `charts/sovereign-agentic-os/policies/trino.rego:322-325` | `table_entitled` if `user in meta.shared_with_users`. Correct, but `user` is a domain name on every path except the personal lane, so it never matches |
| Clearances | `trino.rego:336-346`, `compiler.ts:84-86` | masks are lifted only by a clearance on `principals[user]`. A domain principal has `clearances: []`, so a cleared person's clearance never applies |
| Already per-person | `os-ui/tabs/metrics/lib/build/explore-server.ts:236`, `docs/components/trino.md:347` | metrics and dashboards run as the viewer (`identities.trino.user`) |
| Dagster / dbt | `os-ui/tabs/data/lib/dbt/launch.ts:164-167, 322-323`, `schedules.ts:50` | with run grants on, a build runs as the **actor uid** and a sync as the **dataset owner** (`svc-dagster-runner` impersonates `OS_PRINCIPAL`) |
| Connected syncs | `os-ui/tabs/data/lib/sync-run-server.ts:362` | a connected sync writes as the domain principal |
| Agents | `os-ui/tabs/agents/lib/build/os-tools.ts:44-70` | every agent tool goes through `handleRpc(user, …)` as the acting user, so agents inherit whatever `query_data` does |
| File rules | `os-ui/core/infra/trino-rules.ts:124-138, 182-184` | rules.json (ConfigMap `trino-access-rules`, `trino-rules-server.ts:39`). Impersonation targets = known ids. A domain schema is **owned by the domain name and its member uids**, so a member already owns its domain schema in the file layer |
| Open hotfix | PR #335 | Floor: an ungoverned `iceberg` table in a domain schema is readable only by members of that domain, its self-principal and service identities. Membership comes from `principals[user].domains` |
| Open Company scope | PR #333 | a product-tier dataset compiles to `visibility: "public"`. Visibility is no longer per domain |

Side effects of the domain identity today:

- A person in two domains only ever reads as their **first** domain. Data from domain two looks
  missing.
- The Trino resource group `global.domains.<d>.<user>` is shared by the whole domain
  (`trino.md:347`), so one heavy user throttles their colleagues.
- Trino's `system.runtime.queries` and the Langfuse trace show "sales", not the person.

## 2. Target design

### 2.1 One rule for the session user

> **The Trino session user is the uid of the person the work is done for.** A domain or service
> name is used only by a path on the explicit system list (2.4).

There is one helper, `trinoSessionUser(actor)`, in `core/infra/` and no call site reads
`domains[0]`. `actor` is one of three things:

| Actor | Session user | Example |
|---|---|---|
| `{kind:'person', user}` | `user.id` | UI, MCP `query_data`, chat-to-data, previews, profile, DQ |
| `{kind:'agent', invoker, systemId}` | `invoker.id` (the person who started the run, or the schedule owner) | agent tool call |
| `{kind:'system', principal, purpose}` | `principal` from the system list, never the person | reconcile probes, connected-sync writes until moved, northpeak seed |

`readPrincipalFor` is deleted. The personal-lane flip is no longer needed, because the person is
always the session user.

### 2.2 OPA input identity

Nothing in the input contract changes. Trino sends `context.identity.user` = the session user, and
the Rego looks up `data.governance.principals[user]` for `domains` and `clearances`. The compiler
must make sure that **every active user** is a key with their **roster domains** and clearances.
It already does this from the roster (`compiler.ts:83-86`). Precondition 3 in
`trino-cutover.md` (every active OS user id is a key of `governance.principals`) becomes a hard
check, not a manual comparison.

Effect, without editing the Rego: `table_entitled` checks the person's domains (all of them, not
the first one), `shared_with_users` matches, clearances lift masks, the personal-lane hard deny
works without the regex flip, and #335's membership floor uses the person's roster.

### 2.3 Rego changes (small)

1. **`trino_impersonation.rego` (lines 103-114):** narrow `svc-os-ui` from "any governance
   principal" to:
   - an active OS user (`data.os_data.users[p].active == true`), **or**
   - a name in a new `data.governance.system_principals` set (the 2.4 list), with no domain
     names in it unless the system list names them.

   Domain self-principals stop being impersonation targets for interactive traffic. This is the
   rule the WP-14 comment says WP-35 deletes.
2. **`trino.rego`:** no logic change. Add tests: per-person `shared_with_users` read, clearance
   unmask, a person in two domains reading both, a person reading a foreign Domain table gets
   zero rows, and #335's floor with a uid instead of a domain name.
3. **Write floor (`trino.rego:51-91`):** unchanged. A user's `principal.domains` are their roster
   domains, so `write_target_entitled` holds for their own domain schemas and their personal lane.
4. Optional later: a row-filter hook for per-person row predicates (for example
   `region = <attribute>`) reading `principals[user].attributes`. This is out of scope here and
   listed in the open questions.

### 2.4 The system list (what keeps a non-person identity)

| Path | Today | Target |
|---|---|---|
| dbt build (run grants on) | actor uid | unchanged |
| dbt / dlt sync (scheduled) | dataset owner uid | unchanged. A deactivated owner ends their grants (`run-grants.ts:164`), as today |
| dbt without run grants (flag off) | domain principal | allowed through the system list until `OS_DAGSTER_RUN_GRANTS=1` everywhere, then removed |
| Connected-sync write (`sync-run-server.ts:362`) | domain principal | moved to the owner uid, matching scheduled syncs. Until then, on the list |
| Reconcile probe `verifyDomainTable` (`reconcile.ts:105`) | operator's domain | `{kind:'system', principal:'svc-os-ui', purpose:'reconcile'}`. Read-only metadata, a service identity under #335 |
| `northpeak-marts`, `os-domain-delete`, `dbt-runner` | direct users | unchanged (not impersonated) |
| Promotion publish CTAS | approver (via release) | approver uid, unchanged |

The list is rendered into OPA as `governance.system_principals` from one TypeScript constant
(next to `trino-service-identities.ts`). Every system call is audited with its `purpose`.

### 2.5 The file rules (`trino-access-rules`)

`buildTrinoRules` already enumerates uids:

- **Impersonation:** `impersonationTarget` is the alternation of known ids (`trino-rules.ts:124`).
  After the switch, drop domain names from the targets for `svc-os-ui` and keep them only for
  system-list entries. OPA stays the authority (`OPA_IMPERSONATORS` pass through, line 128), so
  this is defence in depth.
- **Ownership:** a domain schema is owned by `[domain, ...members]` (line 182). Remove the domain
  name once nothing writes as it, so the file owner set equals the members.
- The reconciler already fires on every directory change (`trino-rules-server.ts`, triggers
  boot/event/periodic), so joining or leaving a domain updates rules within one debounce. No new
  trigger is needed.

### 2.6 Agents

An agent acts **as the invoking user**, never as the agent's system principal, for data:

- Interactive run: invoker = the signed-in person. `handleRpc(user, …)` already carries them
  (`os-tools.ts:63-64`), so `query_data` follows rule 2.1 with no agent-specific code.
- Scheduled run: invoker = the schedule owner. The worker reaches Trino through the query-tool
  as `svc-os-ui` today. Target: the worker passes the owner uid, and OPA admits it only while the
  run's `kind=run` grant is live (the rule that already exists for `svc-os-worker`,
  `trino_impersonation.rego` `grant_or_user_allows`).
- Tool **access** stays with the agent system: OPA `agentic.authz` on `os-<systemId>` decides
  *which tools*, and the person's identity decides *which rows*. Neither can widen the other.
- Agent shared with a colleague: the colleague's run reads the colleague's rows, not the owner's.
  This changes behaviour, and it is the point.

### 2.7 Tool access gate (`agentic.authz`)

`authorize(domainPrincipal, 'query')` (`data-query-tools.ts:65`) stays keyed by domain, because
`data.grants[<domain>]` holds `query` and a uid has no grant of its own. Rename the variable to
`toolGrantSubject` so it is not confused with the Trino user. Moving tool grants to people is not
part of this work.

### 2.8 Caching and performance

- **Result caches:** grep found no shared query-result cache in `tabs/data`, `tabs/metrics`,
  `tabs/dashboards` or `governed.ts`. Rule for the future: any result cache must key on the
  session user, never on the domain. Add a test that fails if a cache key omits it.
- **OPA load:** impersonation adds one `ImpersonateUser` decision per new Trino session. The
  sidecar OPA (`trino.opa.sidecar`, WP-14 step 2b) answers locally in under 1 ms.
  `governance.principals` grows from about the number of domains to the number of users plus
  domains, which is hundreds of small objects. That is negligible.
- **Trino:** the resource group becomes truly per person (`trino.md:347`). Measure that the 2/40
  per-user limit still fits a dashboard fan-out. It was sized for that.
- **Freshness:** a roster change reaches OPA through the existing push/bundle (5 min push, about
  60 s bundle; PR #333 note 2). Membership removal should push immediately. Add the governance
  principals source to the directory-change trigger the rules reconciler already uses.

### 2.9 Audit

- Every `query_data` trace records `actingUser` (uid), `sessionUser` (equal to actingUser except
  on system paths), `toolGrantSubject` (domain), `agentSystem` (if any) and `purpose` (system
  paths).
- System-path reads append an `os_governance.audit_events` row
  (`core/adapters/postgres/audit.ts`, `actorKind:'service'`).
- Trino's own `system.runtime.queries."user"` now shows the person, which matches the OPA
  decision log line for line.

## 3. Migration

No data moves. This is an identity switch behind a flag.

1. **Flag** `OS_TRINO_SESSION_AS_USER` (os-ui env, default off). Off = today's `domains[0]`.
2. **Before on, check that:**
   - every active user is a key in `governance.principals` (new startup check, red row in
     Platform → Components & Health);
   - every multi-domain user's roster is correct, because they will now see all their domains;
   - #335 and #333 are merged.
3. **Dev, on.** Run the parity suite (below). Compare row counts per dashboard and per dataset
   for a sample of users against the flag-off answer. Expected differences are:
   - multi-domain users see more;
   - people named in `shared_with_users` see the shared table;
   - cleared people see unmasked columns.
   Anything else is a bug.
4. **Prod, on**, after the owner tests dev and says go. Rollback = flag off (seconds).
5. **Narrow the impersonation rule** (2.3.1) and drop domain names from the file-rule targets and
   owners (2.5). Ship this as a separate release after a week with the flag on, so rollback stays
   one flag until then.
6. **Delete** the flag, `readPrincipalFor`, and the self-principal comment in the compiler. Keep
   emitting self-principals only for names on the system list.

## 4. Tests

| Level | Test |
|---|---|
| Rego (`opa test`) | `shared_with_users` uid read; clearance unmask; two-domain member; foreign uid gets zero rows; #335 floor with uid; `svc-os-ui` may impersonate an active uid and a system-list name, but **not** a domain name, an inactive uid or a `svc-*` name |
| Unit (os-ui) | `trinoSessionUser` for the three actor kinds; no file outside `core/infra` reads `domains[0]` for a Trino principal (a structure check in `scripts/`, like `no-trino-grants.test.ts`); compiler emits every active user |
| Integration (real Trino 476 + OPA, `tests/lakehouse/`) | extend `parity.int.test.mjs`: the same query as user A, user B and a domain principal gives the expected row sets; `impersonation.int.test.mjs`: domain-name target refused after step 5 |
| E2E (kind) | Data tab preview, `query_data` over MCP, a dashboard and an agent run, each as a person in two domains and as a person named on a share |
| Independent verifier | a reviewer who did not write it runs the dev parity comparison and signs off |

## 5. Risks

| Risk | Mitigation |
|---|---|
| A user missing from `governance.principals` reads **zero rows** everywhere (fail closed) | startup check plus health row; compiler emits every active user on every compile; refuse to turn the flag on while the check is red |
| Multi-domain users suddenly see more | intended, but announce it; the dev comparison lists every user whose visible set grows |
| Admins lose reads they had through a domain | same as today: an admin reads as their own roster. Document that admin is not a data superuser |
| Scheduled agent runs need grants the worker does not hold yet | keep scheduled runs on the current path until the `kind=run` grant wiring is proven on dev; ship interactive first |
| Hidden callers still pass a domain | the structure check fails CI on any `domains[0]` used as a Trino principal |
| Resource-group limits hit per person | measure on dev; the per-person limit is configurable (`trino.resourceGroups.config`) |
| OPA freshness after a membership removal | push on directory change (2.8); the bundle mode caps it at about 60 s |

## 6. Phased tasks

- [ ] **P0 — prerequisites.** Merge #335 and #333. Add the "every active user is a governance
  principal" check and health row. Add `governance.system_principals` (empty) and its source
  constant.
- [ ] **P1 — one helper.** Add `trinoSessionUser(actor)` in `core/infra/`. Replace every
  `domains[0] ?? user.id` Trino principal (about 25 sites, listed in section 1) behind
  `OS_TRINO_SESSION_AS_USER`. Add the structure check. Add trace fields (2.9).
- [ ] **P2 — system paths.** Route reconcile, connected-sync writes and any remaining non-person
  read through `{kind:'system'}` with a purpose and an audit row. Move connected-sync writes to
  the owner uid.
- [ ] **P3 — tests.** Rego tests, lakehouse parity and impersonation integration tests, e2e
  journeys.
- [ ] **P4 — dev rollout.** Flag on in dev, run the row-set comparison, independent verifier.
- [ ] **P5 — prod rollout.** Only after the owner tests dev and says go.
- [ ] **P6 — narrow.** Impersonation rule (2.3.1), file-rule targets and owners (2.5), separate
  release.
- [ ] **P7 — scheduled agents.** Worker passes the schedule owner, gated by a `kind=run` grant.
- [ ] **P8 — clean up.** Delete the flag, `readPrincipalFor` and the stale comments; update
  `docs/components/trino.md` and `trino-cutover.md`.

## 7. Open questions for the owner

1. **Admins and data.** Should an admin read every domain's Domain-scope data, or only their own
   roster (today's behaviour)? This design keeps "own roster only".
2. **Shared agents.** When a colleague runs an agent someone else built, rows follow the
   colleague (this design). Is there any case where the agent should read with the owner's rights
   (a "service agent")? If yes, it needs its own system-list entry and a visible warning, like a
   shared connection credential.
3. **Per-person row predicates** (for example "sales reps see only their region"). This is not in
   scope. Do you want it next? It needs user attributes in the roster and one Rego clause.
4. **Domain switcher.** Should the UI's active domain *narrow* what a multi-domain person reads
   (for example to keep a dashboard to one domain), or is it display-only? This design reads with
   all roster domains.
5. **Connected-sync writes:** move to the owner uid (recommended) or keep a domain identity for
   those writes?
