<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# #146 — Analytics-as-Code Monorepo: Build Plan

Date: 2026-07-20 · Status: **PLAN (design only — no code in this change)**
Builds on: `docs/research/dagster-dbt-cube-superset-metricflow.md` (2026-07-19),
`docs/research/developer-mode-cli.md`, `cli/sos/ROADMAP.md` Phase 3.

> **One open governance decision is deliberately NOT decided here** — the git
> identity model (shared Forgejo service account vs per-user tokens). See §6.
> Everything else in this plan is implementation-ready either way; §6 states
> exactly what each choice changes.

---

## 0. Honest starting point — more of #146 exists than the epic title suggests

Verified against the repo. The epic is **not** greenfield; Phases 1–6 of the
original #146 plan are already shipped in some form:

| Already shipped | Where | State |
|---|---|---|
| Ph 1 — `analytics` repo seed (dbt project + cube seed models + dagster defs + CI skeleton) | `charts/sovereign-agentic-os/templates/software/analytics-seed.yaml` (gate: `analyticsRepo.enabled`, default **false**) | Live, idempotent, post-install+post-upgrade |
| Ph 2 — registry → git mirror (Cube YAML + dbt exposures, diff-only, boot reconcile) | `os-ui/lib/data/analytics-repo.ts` (+ `instrumentation.ts` hook, `/api/admin/analytics/backfill`) | Live |
| Ph 3 — Cube serving can read models **from git** | `values.yaml` `cube.modelSync.source: os-ui\|git` | Built, default `os-ui` |
| Ph 4 — Dagster user-code can clone dbt project **from git** | `values.yaml` `dbt.projectSource: image\|git` + commented initContainer block under `dagster-user-deployments` | Built but **commented out** (subchart values can't be Helm-conditionalized) |
| Ph 5 — CI publishes `manifest.json`/`catalog.json` to the S3 prefix OM reads | `.forgejo/workflows/ci.yml` `publish-dbt-artifacts` job (seeded by analytics-seed) | Live in seed; OM flag still off |
| Ph 6 — git-backed dbt models for promoted datasets (`gitBacked: true`) | `analytics-repo.ts` `buildDbtModelSql`/`buildDbtSchemaYaml`; `dataset-schema.ts:196` | Live, observability-grade only |

**What this epic actually delivers (the remaining gap):**

1. The **push-through-policy pipeline** — the piece `cli/sos/ROADMAP.md` names as
   still-future: *"analytics-monorepo push-through-policy (Forgejo Actions →
   OPA/Conftest → registry apply → Cube regen)"*. Today git is a one-way mirror;
   a human/`sos push` edit to the repo goes **nowhere**.
2. **Turning the built-but-off git-serving paths on** as the default operating
   mode (Cube modelSync `source: git`, Dagster `dbt.projectSource: git` as real
   templated values, not a commented block).
3. **Dagster made real** — schedules for dbt build + Cube refresh + DQ, governed
   principal, relationship to the three existing CronJobs settled.
4. **OM ingestion from the repo** — flip `openmetadata.ingestion.dbt.enabled`,
   optionally add the OM Dagster pipeline connector, and prove it composes with
   the #147 registry-side orchestrator without double-writes.
5. **Surface the git-identity decision** (§6) that gates the human-push half.

**Locked constraint carried forward (do not relitigate):** the **registry stays
authoritative for compute**. Git is a *proposal + mirror*, Terraform-style
plan → policy → apply. This was the explicit recommendation of
`developer-mode-cli.md` ("do not invert this naively") and `cli/sos/ROADMAP.md`
Phase 3, and it protects the crown jewel: `os-ui/lib/data/policy/compiler.ts`
(one source → Trino-OPA + Cube access policies, conformance-tested). Nothing in
this plan creates a second source of truth.

---

## 1. The goal

A governed git monorepo (`analytics` in Forgejo) where **dbt models, Cube
semantic models, and Dagster orchestration live together** — versioned,
reviewed, CI-checked — and from which **OpenMetadata ingests lineage and
tests**. Analytics becomes *code, not clicks*, **without** losing the OS's
governance: every change still passes OPA policy, the tier ladder
(Personal → Shared → Certified), and the promotion/approval flow. Two authoring
paths stay first-class forever:

- **Guided builder** (Data tab / MCP `transform_silver`, `build_gold_join`,
  `define_metric`) → registry → CTAS + Cube regen → **mirrored into git** by
  `analytics-repo.ts`. Unchanged.
- **Code path** (local edit → `sos push` / git PR) → Forgejo → **CI policy
  gate** → merge → **governed registry apply** → the same CTAS/Cube regen →
  the mirror converges (diff-only writes make this idempotent — after a
  successful apply, the mirror re-emits byte-identical files and writes
  nothing).

Both paths end in the registry; git and registry can never fight because the
apply is the only door from git into compute, and the mirror is the only door
from compute into the OS-managed git paths.

---

## 2. Repo structure

Extends the shipped seed layout — no renames of existing paths (byte-stable
upgrades). One repo per tenant; **domain = directory**, matching the
`iceberg.<domain>` schema and `#155` cube-namespacing (`<domain>__<slug>`).

```
analytics/
├── README.md                          # OS-managed-paths notice (shipped)
├── dbt/                               # ONE dbt project (profile: sovereign, dbt-trino)
│   ├── dbt_project.yml                # shipped
│   ├── profiles.yml                   # env-var driven (TRINO_HOST/USER/…) — shipped
│   ├── seeds/                         # demo seed (shipped)
│   ├── models/
│   │   ├── staging/ marts/            # demo project (shipped) — human-editable
│   │   ├── governed/<domain>/         # OS-MANAGED: <layer>_<slug>.sql + schema.yml
│   │   │                              #   (emitted by analytics-repo.ts Ph 6)
│   │   └── exposures.yml              # OS-MANAGED (EXPOSURE_ARTIFACT mirror)
│   └── tests/                         # NEW: human-authored dbt tests (generic+singular);
│                                      #   governed DQ checks stay in the OS DQ engine
├── cube/
│   └── models/
│       ├── seed/                      # static demo cubes (shipped)
│       └── metrics/<slug>.cube.yml    # OS-MANAGED mirror of buildCubeModels output
├── dagster/
│   ├── definitions.py                 # shipped; grows schedules/jobs (§4)
│   └── schedules.yml                  # NEW: declarative schedule spec (parsed by
│                                      #   definitions.py — reviewable, policy-checkable)
├── policy/                            # NEW: the Conftest/OPA policy pack (Rego)
│   ├── dbt.rego                       # governed-path + SQL-shape rules (§3 step 4)
│   ├── cube.rego                      # cube naming/#155 namespace/no-sql_table-escape
│   └── README.md                      # "these are the PRE-MERGE gates; the server
│                                      #  re-enforces on apply — CI is not the boundary"
└── .forgejo/workflows/ci.yml          # shipped; grows the conftest + apply steps (§3)
```

Mapping rules (all already encoded in code — reuse, never re-implement):
- dataset → dbt model path: `dbtModelPath()` in `analytics-repo.ts`
  (`dbt/models/governed/<domainSchema>/<layer>_<slug>.sql`).
- dataset → cube file: `CUBE_ARTIFACT`/`artifactBase` in `lib/data/metrics.ts`
  (mirrored under `cube/models/metrics/`).
- domain → warehouse schema: `domainSchema()` in `store-fqn.ts`.
- **OS-managed vs human paths:** `dbt/models/governed/**`, `dbt/models/exposures.yml`,
  `cube/models/metrics/**` are OS-managed (mirror wins; human edits there must go
  through the apply pipeline or be overwritten on next promotion). Everything
  else is human-space, preserved forever (sha-diff writes never touch it).

**Coexistence guarantee (test-backed):** the builder path and the repo hold the
*same bytes* — `buildDbtModelSql`/`buildCubeModels` are the single emitters used
by both the mirror and (new) the apply verifier. A CI check fails any PR that
hand-edits an OS-managed file into a shape the emitters could not produce.

---

## 3. The governed pipeline (every step named; where policy is enforced)

```
 (1) local edit            dbt SQL / cube YAML / dagster schedule in a working dir
 (2) sos push --analytics  diff → governed `commit` MCP tool AS THE USER → policy
        │                  pre-check server-side (OPA; a DENY surfaces as ToolError)
        ▼                  [alternative: plain git push to a branch — §6 decides identity]
 (3) Forgejo               branch / PR on `analytics` (never direct-to-main for
        │                  OS-managed paths — branch protection on main)
        ▼
 (4) Forgejo Actions CI    runner: templates/software/ci-runner.yaml (act_runner+DinD)
        │                  jobs, in order:
        │                    a. validate     — dbt parse + cube YAML lint   (shipped)
        │                    b. conftest     — NEW: conftest test over the CHANGED
        │                       files with policy/*.rego: governed-path ownership,
        │                       #155 naming, sql_table must be iceberg.<domain>.*,
        │                       no raw cross-domain refs, schedule sanity.
        │                       ADVISORY GATE: blocks merge, but is NOT the security
        │                       boundary (CI can be edited; the server re-enforces).
        │                    c. dbt build --target ci (optional, needs warehouse) —
        │                       compile + tests against a scratch schema
        ▼
 (5) merge to main         requires review approval (who can approve = §6 + the
        │                  existing promotion ladder: builder+ for Shared-tier assets)
        ▼
 (6) registry apply        NEW governed step — THE enforcement point, never bypassed:
        │                  CI job (or Forgejo webhook) calls os-ui
        │                  `POST /api/analytics/apply { sha }` authenticating the
        │                  ONLY governed way (service-principal login — the exact
        │                  pattern of dq-cronjob/catalog-refresh-cronjob). os-ui:
        │                    • reads the diff at <sha> from Forgejo,
        │                    • maps changed OS-managed files → datasets (path map §2),
        │                    • re-runs OPA/tier/promotion checks AS the mapped
        │                      principal (commit author when §6=per-user; the PR's
        │                      OS approver otherwise),
        │                    • updates the registry (measures / publishPlan inputs),
        │                    • REJECTS anything the emitters can't round-trip
        │                      (single-writer invariant: registry stays authoritative).
        ▼
 (7) materialize + serve   registry apply triggers the EXISTING machinery:
        │                    • governed CTAS (publish-server.ts) or — once Dagster
        │                      is the executor for git-backed marts (§4, decision
        │                      A1 from the prior research: observe-only FIRST) —
        │                      a Dagster `dbt build` run of the changed selection,
        │                    • Cube regen → modelSync sidecar (source: git) hot-reloads,
        │                    • mirror re-emits → byte-identical → zero commits (converged).
        ▼
 (8) OM ingest             CI `publish-dbt-artifacts` (shipped) uploads manifest/catalog
                           → S3 `dbt/artifacts/` → OM dbt ingestion (flag flip, §5)
                           + #147 orchestrator keeps writing the governed-mart entities.
```

**Where policy is enforced (and never bypassed):**
- Step 2: server-side OPA on the governed `commit` (only when pushing through
  `sos push`; a raw git push skips this — which is exactly why step 6 exists).
- Step 4b: Conftest **pre-merge gate** — fast feedback, not the boundary.
- Step 6: **the boundary.** The apply route runs the same OPA + tier +
  promotion-ladder checks as the UI/MCP, as a real principal, DLS-scoped. A
  merged PR that fails policy here does **not** reach compute; the apply posts a
  failure status back to the PR (honest, visible, no silent drop).
- Step 7: unchanged existing enforcement — Trino-OPA on every read the CTAS/dbt
  run performs; Cube access policies from the same compiler.

---

## 4. Dagster's role

**What Dagster owns:** orchestration of the *warehouse-side* analytics loop —
`dbt build` of the monorepo project (demo + `models/governed/**`), dbt-test
runs as asset checks, Cube refresh nudge, and (optional, per prior research
A4) Superset cache warm-up. It does **not** own OS-side governance jobs.

**Deployment (already in place, needs activation, not invention):**
- Chart dep `dagster` **1.13.11** (`Chart.yaml:66`), Apache-2.0 (license
  register row 76). Custom arm64 image `sovereign-os/dagster:0.2.0` for
  webserver/daemon/user-code; CNPG `dagster` DB.
- Work item: promote the **commented** git-clone initContainer block
  (`values.yaml` ~1439–1478) into a real, templated path — because the
  `dagster-user-deployments` subchart values are static YAML, generate the
  block via a values-level toggle in our own values files
  (`values.yaml` + overlays), documented in `values.example.yaml`. The
  initContainer shallow-clones `analytics/dbt` and runs `dbt parse` so
  `@dbt_assets(manifest=…)` loads the *repo's* project, not the baked image.
- `dagster/definitions.py` in the repo grows: `build_schedule_from_dbt_selection`
  for governed models, a DQ-artifact asset, and jobs read from `dagster/schedules.yml`
  so schedule changes are reviewable code that flows through §3.

**Governed principal:** Dagster's runs hit Trino as `TRINO_USER: dbt-sales`
today. Plan: introduce a dedicated **`dagster-analytics` warehouse principal**
(same OPA-governed identity mechanism as `dbt-sales`/`cube-sales`), granted
read on sources + write ONLY on the governed target schemas. Its Forgejo read
access is part of the §6 decision (machine flows can keep a scoped machine
token under either option). Dagster never gets an os-ui admin session and
never calls ungoverned APIs.

**Materialize vs observe (carried decision, restated honestly):** the prior
research (Tier A1) recommends **observe-only first** — Dagster assets mirror
the CTAS-built tables; `publish-server.ts` stays the single Gold writer. This
plan adopts that: Phase D1 = observe + schedule dbt *tests*; Phase D2
(explicitly optional, needs its own go/no-go) = Dagster becomes the executor
for `gitBacked` marts, at which point the CTAS path for those datasets is
disabled to keep exactly one writer.

**Relationship to the three existing CronJobs** (`metrics/dq-cronjob.yaml`,
`metrics/metrics-alert-cronjob.yaml`, `openmetadata/catalog-refresh-cronjob.yaml`):
**keep them.** They drive *app-side governed routes* with a logged-in service
principal — that auth pattern is correct and audited, and moving them into
Dagster would give the orchestrator an app credential it doesn't need.
Rule of thumb this plan fixes in writing: **warehouse-side work → Dagster;
app-route work → CronJobs.** (A later consolidation could have Dagster ops call
the same routes with the same principal Secret — allowed, but it buys nothing
and is out of scope for #146.)

---

## 5. OpenMetadata ingestion from the repo

Three legs, each with a distinct namespace, so they compose without
double-writes:

1. **dbt artifacts leg (this epic's flip):** CI already publishes
   `manifest.json` + `catalog.json` to S3 (`dbt` bucket, `artifacts/` prefix,
   seaweedfs endpoint) on every merge to main. The OM Trino ingestion CronJob
   (`openmetadata/trino-ingestion.yaml`) already supports
   `dbtConfigSource` (s3/local) **gated behind
   `openmetadata.ingestion.dbt.enabled` (default false)**. Work = flip the flag
   in the overlays once governed models flow, and live-verify that OM attaches
   dbt descriptions/lineage/tests **onto the Trino-service table entities** it
   crawled natively (matching on `iceberg.<domain>.<table>` FQNs — the
   governed emitters already produce exactly those FQNs).
2. **Registry-side orchestrator (#147, shipped):**
   `os-ui/lib/connections/openmetadata-ingest.ts` writes **only additively
   inside the dedicated `sovereign_os` service namespace**
   (managedBy=SovereignOS, 7 guards, version-fail-closed). **No conflict by
   construction:** leg 1 decorates the *customer's Trino service* entities; leg
   2 owns the *sovereign_os* entities and their Data-Product/lineage edges. The
   composition rule to enforce in review + a test: **the dbt ingestion must
   never be pointed at the `sovereign_os` service**, and the orchestrator never
   writes table entities under the Trino service. Cross-namespace lineage stays
   with OM's native crawl, exactly as #147 documented.
3. **Dagster pipeline lineage (optional, last):** OM has a native Dagster
   pipeline connector (GraphQL-based) that ingests runs/ops as Pipeline
   entities + table lineage. Add it as a values-gated ingestion
   (`openmetadata.ingestion.dagster.enabled`, default false) mirroring the
   dbt gate. Honest caveat: unverified against our OM 1.13 + Dagster 1.13
   pairing — treat as a live-verify item, ship default-off, and drop it
   without regret if the connector versions don't line up (dbt-artifacts
   lineage already covers the model graph).

---

## 6. THE OPEN DECISION — git identity: shared service account vs per-user tokens

> **This is the user's call. The plan does not decide it.** It is pending
> decision #1 in `docs/ROADMAP.md` ("Retire the shared Forgejo service
> account → per-user tokens — unblocks *full* Git/Jira + `sos push`") and it
> gates the human half of the §3 pipeline.

**Today:** every git actor is the Forgejo admin (`forgejo.gitea.admin.username`,
`gitea_admin` locally): the analytics-seed Job, the CI runner token bootstrap,
the Cube modelSync git source, the Dagster clone initContainer, and the
registry mirror (`config.forgejoUser` per `developer-mode-cli.md`). Human
attribution exists only as a commit-message trailer (`[by <principal>]`).

### Option A — keep the shared service account (status quo, hardened)

| | |
|---|---|
| **Attribution** | Git history shows ONE author for everything. OS-side audit stays correct (the apply step maps changes to a principal), but `git blame`, Forgejo PR reviews, and any external audit of the repo cannot distinguish users. Commit-trailer attribution is honest but spoofable by anyone holding the SA. |
| **Governance** | Forgejo-native controls (branch protection, required reviewers, CODEOWNERS-style rules) are meaningless — everyone is the same admin, who can bypass them. ALL review/approval weight falls on the OS promotion ladder + the §3 step-6 apply. Workable, but the PR review in Forgejo is theater. |
| **Security** | One credential = admin over ALL repos (os-mirrors, software apps, analytics). It is currently inlined in values files and CI env. Blast radius of a leak: total git compromise. Rotation is all-or-nothing. |
| **Pipeline impact** | §3 step 2 must treat every push as an **anonymous proposal**; step 6 cannot trust commit authorship and must derive the acting principal from the OS-side approval that accompanies the merge (i.e. a `request_promotion`/`approve_promotion` pair recorded in the OS, linked to the PR). `sos push --analytics` works, but only via the MCP `commit` route — never raw git. Desktop `git clone/push` for humans stays effectively unsupported. |
| **Effort** | ~zero new work; optionally split the admin into a **non-admin, repo-scoped machine account** (cheap, recommended regardless). |

### Option B — per-user, server-minted, short-lived, domain-scoped Forgejo tokens

(The shape already designed in `developer-mode-cli.md` + Workbench: os-ui mints
a scoped token on `sos login`; a `sos git` credential helper refreshes it;
Forgejo users mirror OS identities.)

| | |
|---|---|
| **Attribution** | Real: commits/PRs/reviews carry the actual user. `git blame` = audit trail. The §3 apply can map commit author → OS principal directly and re-check OPA *as that person*. |
| **Governance** | Forgejo branch protection + required reviews become REAL and can mirror the OS ladder (builder+ = allowed approvers on `main` for OS-managed paths). Two gates (Forgejo review + registry apply) enforce the SAME rule from the same role data. |
| **Security** | Least privilege: tokens are short-TTL, scoped to the user's domains' repos, minted server-side, revoked centrally on deactivation. The admin SA shrinks to bootstrap-only. New surface to build correctly: token mint/refresh endpoint, Forgejo user provisioning (API-created users synced from OS identity), scope mapping. |
| **Pipeline impact** | Unlocks the FULL pipeline: raw `git push`/desktop clone, `sos clone/pull/push` via credential helper, real PRs. Step 6 gains a stronger identity signal. Machine flows (seed, mirror, modelSync, Dagster clone, CI checkout) still use a **machine account — but a scoped, non-admin one**. |
| **Effort** | The real cost of this epic's Phase 0: os-ui token-mint route + Forgejo user-sync + `sos git` credential helper + migrating 5 machine consumers off the admin credential. Estimated the largest single chunk of #146. |

**What each implies for THIS plan:** the §3 pipeline ships under either option —
under A, steps 2/3 are MCP-`commit`-only and Forgejo review is decorative;
under B, raw-git + real PR review light up and step 6 gets author-mapped
principals. §§2, 4, 5 and 7 are identical under both.

**Recommendation (yours to accept or reject):** **Option B for human flows,
with a scoped non-admin machine account for automation** — it is the only
option under which "reviewed, versioned analytics code" is literally true at
the git layer rather than simulated above it, and it is already the direction
of `developer-mode-cli.md` and `docs/ROADMAP.md`. Honest counterpoint: if the
near-term user base is 1–3 trusted builders, Option A + hardened machine
account delivers the whole pipeline sooner, and B can be retrofitted without
rework (the apply seam doesn't change). **Decision needed before Phase 2
below; Phases 0–1 are identical under both.**

---

## 7. Phased plan, tests, licensing, live-verify

### Phase 0 — decisions + policy pack (no behavior change)
- Present §6 to the user; record the outcome as `docs/decisions/0006-git-identity-model.md`.
- Add `policy/*.rego` + `policy/README.md` to the seed
  (`charts/sovereign-agentic-os/templates/software/analytics-seed.yaml` ConfigMap).
- Add the `conftest` job to the seeded `.forgejo/workflows/ci.yml` (pinned
  conftest binary, no external actions — same sovereign-checkout pattern).
- Optionally (both §6 options): create the scoped machine account
  (`analytics-bot`, non-admin, repo-scoped) in `forgejo-seed.yaml` and move
  the mirror/modelSync/Dagster-clone credentials to it.

### Phase 1 — registry apply (the pipeline's enforcement point)
- `os-ui/lib/data/analytics-apply.ts` (pure: diff-at-sha → dataset mapping →
  round-trip verification against the existing emitters) +
  `os-ui/app/api/analytics/apply/route.ts` (auth: session principal; CronJob-style
  service-principal login for CI, mirroring `catalog-refresh-cronjob.yaml`).
- CI `apply` job on push-to-main calling the route; PR status write-back.
- MCP surface: reuse `commit`/`request_promotion` — no new tool unless the
  apply needs a preview verb (`preview_analytics_apply`, admin-gated).

### Phase 2 — identity build-out (shape depends on §6)
- **If B:** token-mint route + Forgejo user provisioning + `sos git`
  credential helper (`cli/sos/internal/…`), branch protection on `analytics`
  main mapped to builder+.
- **If A:** document the MCP-only contract; enable branch protection with the
  machine account as sole pusher; `sos push --analytics` lands against the
  governed `commit` path (extending `cli/sos/internal/push/` to target the
  analytics repo's OS-managed paths).

### Phase 3 — serving flips to git
- `cube.modelSync.source: git` in the default overlays (sidecar already keeps
  last-good models on Forgejo outage — verified fallback stays).
- Promote the Dagster git-clone initContainer from comment to real values in
  `values.yaml` / overlays; `dbt.projectSource: git`.
- Rollback story: both are single-values flips back to `os-ui`/`image`.

### Phase 4 — Dagster real (observe-first)
- Grow `dagster/definitions.py` + `dagster/schedules.yml` in the seed:
  governed-model selection schedules, dbt tests as asset checks,
  `dagster-analytics` Trino principal in values + OPA identity config.
- Explicit go/no-go checkpoint before any move to Dagster-as-executor
  (single-writer rule; prior research A1).

### Phase 5 — OM from the repo
- Flip `openmetadata.ingestion.dbt.enabled` in overlays; verify FQN matching
  and the §5 namespace-separation rule (add a conformance test beside the
  existing openmetadata-sync tests asserting the dbt config never targets
  `sovereign_os`).
- Optional `openmetadata.ingestion.dagster.enabled` (default false).

### Test strategy
- **Unit (fast, no infra):** analytics-apply diff/mapping/round-trip
  (`analytics-apply.test.ts` beside `analytics-repo.test.ts`); Rego policies
  via `conftest verify` fixtures (good/bad dbt SQL + cube YAML); sos push
  target-path logic in Go (`internal/push`).
- **Chart:** `helm template` golden tests — defaults render byte-identical
  (every new path values-gated off), then each flag on.
- **kind e2e:** seed → edit a governed model via PR → CI gate red/green →
  merge → apply → registry updated → Cube reloads from git → mirror converges
  with zero commits (the idempotence proof) → dbt artifacts land in S3.
- **Conformance:** builder-path vs code-path produce identical bytes for the
  same dataset (extends the existing emitter tests).

### Licensing check (permissive-only house rule)
- **Dagster 1.13.11 — Apache-2.0. Confirmed** (`THIRD-PARTY-LICENSES.md` row 76).
- dbt Core / dbt-trino — Apache-2.0 (row 70). Cube — Apache-2.0 (row 72).
  OPA — Apache-2.0 (row 75). Conftest (new dependency, CI-only binary) —
  Apache-2.0; **add a register row + pin the version** in Phase 0.
- Forgejo — GPL-3.0-or-later, already accepted as a **separate service (mere
  aggregation)** with a source offer (`licenses/source-offer.md`); this epic
  adds no linkage, so the stance is unchanged. Forgejo Runner — MIT.
- `check:licenses` (os-ui) + the register update run in the release gate as
  always.

### Needs live infra to verify (cannot be proven statically)
1. Forgejo Actions end-to-end on the in-cluster runner (DinD) incl. the new
   conftest + apply jobs and PR status write-back.
2. OM dbt-artifacts ingestion actually attaching to the Trino-crawled
   entities (FQN match) on OM 1.13.
3. Cube modelSync `source: git` hot-reload latency + outage fallback.
4. Dagster git-sourced `dbt parse`/manifest freshness on pod restart.
5. (Option B only) token mint → credential-helper → raw push from a real
   desktop.
6. The full converge loop: builder-path promotion and code-path merge landing
   the same bytes with zero mirror churn.

---

*Every existing file/flag named above was verified in the repo on 2026-07-20;
the OM-Dagster connector compatibility (§5.3) is the one externally-unverified
claim and is marked as such.*
