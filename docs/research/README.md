# Research Reports — Decision Index

Five advisory research reports. Each is cited, grounded in the live codebase, and ends with explicit decisions for you to make before implementation begins.

Read this page first. Deep-link into individual reports only for the full evidence.

---

## 1. Dagster + dbt Core + Cube + Superset (and MetricFlow)

**File:** [dagster-dbt-cube-superset-metricflow.md](./dagster-dbt-cube-superset-metricflow.md)

**Summary:** The current stack is already on the 2026 golden path for Cube↔Superset (SQL API, dual-layer RLS, same-origin proxy) and dbt↔Dagster (`@dbt_assets` + `DbtCliResource`). The real gaps are that Dagster and dbt only drive demo data — not the governed marts — and some known Cube SQL API edge cases (integer precision, join limits) are unguarded. The MetricFlow-define→Cube-serve pattern the report was asked to evaluate turns out to be unsupported: `cube_dbt` moves physical models, not metric definitions, and there is no converter. The single-source RLS policy compiler (`policy/compiler.ts`) is correctly identified as the platform's crown jewel; any path that splits metric authoring into two homes breaks it.

**Headline recommendation:** Keep the registry+Cube as define+serve (re-affirming decision #141). Wire Dagster to the governed marts as an observe-only asset graph. Do NOT pursue MetricFlow serving.

**Decisions you must make:**
- Dagster for governed marts: **observe-only** (recommended) vs. full materializer — two writers racing on Gold tables is the risk.
- Tier B: migrate governed CTAS to real dbt models (unlocks `cube_dbt` manifest + lineage) or keep as-is? This is optional and medium-effort.
- Tier C: confirm the MetricFlow-serving door is closed (recommended yes, re-affirms #141).

---

## 2. Governed Developer Mode — `sos` CLI / Homebrew / devcontainer

**File:** [developer-mode-cli.md](./developer-mode-cli.md)

**Summary:** The platform is ~70% of the way to a server-hosted dev mode (MCP with OAuth 2.1/PKCE already live, Workbench tab designed) but ~30% of the way to what engineers actually want: a bring-your-own-desktop flow. The existing OAuth server already allowlists a loopback redirect for CLI auth; the MCP already has ~85 governed tools; the gap is (1) a `sos` CLI binary that wraps those tools, (2) per-user short-lived Forgejo tokens replacing the shared service account, and (3) a devcontainer that pre-wires MCP + repos on the engineer's own machine. The report distinguishes MCP (right for agent/LLM-driven mutations) from a typed CLI REST layer (right for deterministic, high-volume, scripted reads) and recommends Go + GoReleaser for multi-platform distribution with a self-hosted Homebrew tap (EU-sovereign: no github.com in the trust path).

**Headline recommendation:** Build `sos` as a Go binary, Phase 1 = thin MCP-backed CLI + GoReleaser distribution; Phase 2 = devcontainer + per-user git tokens; Phase 3 = git-push-through-policy for the analytics monorepo.

**Decisions you must make:**
- Commit to a stable `/api/v1` external contract alongside MCP, or keep MCP-only and accept the token-overhead tradeoffs for scripted use?
- Registry stays authoritative for the analytics monorepo (git-push = proposal, not direct write) — confirm this is the intended model.
- Retire the shared Forgejo service account for human git flows in favor of short-lived per-user domain-scoped tokens?
- Own-desktop CLI+devcontainer first, or finish/deploy the already-designed browser Workbench (`code-server`) first?
- Self-host the Homebrew tap + installer on the OS instance/Forgejo (no github.com dependency) — required for EU-sovereign posture?

---

## 3. Data Quality UX — Collate / Soda / Monte Carlo / Anomalo + IA Placement

**File:** [data-quality-ux.md](./data-quality-ux.md)

**Summary:** The existing DQ engine (`dq.ts` / `dq-run.ts`) has a solid honesty contract (0 violations = pass, else fail, unrunnable = `not_run` — never a fake pass) but only five hand-authored rule kinds, no history, no freshness/volume/schema monitors, no scheduling, and no alerting. Critically, `openmetadata.ts` already contains the `createOmTestCaseResult()` write-back with 7 integrity guards — the OM DQ pipeline is built but not wired. The report synthesises four competitors (Collate/OM, Soda, Monte Carlo, Anomalo) into a design target: auto-suggest checks from the profile, auto-monitors on by default (freshness/volume/schema), plain-language rule authoring, a health score + trend, and an incident feed. The IA recommendation is a dedicated **Quality** stage in the Data tab (6 stages: Define · Ingest · Refine · Quality · Publish · Use) with a read-only DQ rollup in Monitoring.

**Headline recommendation:** Add a dedicated Quality stage; wire profile→suggestion and plain-language authoring; activate the OM TestCase write-back that is already built; add freshness/volume/schema heuristic monitors (statistical, not ML) on by default.

**Decisions you must make:**
- Confirm the IA: promote DQ to a dedicated **Quality** stage (6 stages total) — recommended — or keep it woven in Define/Publish?
- Auto-monitors (freshness/volume/schema) default-**ON** for every dataset, or opt-in?
- Anomaly detection: in-cluster statistical monitors (sovereign, recommended) vs. defer to OM-native evolving features, and how far into ML do you want to go?
- OM DQ write-back: activate now (the code is built and guarded) or hold until the writer bot is validated on the live tenant?

---

## 4. Software Build Stage — Lovable-style UX (preview / hot-reload / scaffold / step-by-step)

**File:** [software-build-lovable.md](./software-build-lovable.md)

**Summary:** The sovereign agentic build spine already exists (LiteLLM→STACKIT models, `commitToApp`→Forgejo, git checkpoints, `decide_deploy` gate). The only gap is the *inner loop* — every change currently triggers a full container build+deploy cycle. The report maps three preview architectures (in-browser Sandpack, server-side Vite HMR pod under Kata isolation, current image-build-as-preview) and recommends a two-tier approach: Sandpack (Apache-2.0, instant, frontend-only) for everyday edits, a Kata-isolated Vite HMR pod (full-stack, on demand) to replace the build-to-preview cycle, keeping the image build strictly for go-live. For scaffold, the recommendation is `vite-react-supabase` (Vite SPA + nginx:8080 + self-hosted Supabase) as the default, replacing Next.js standalone for AI generation targets. The step-by-step guided build maps `App.epics[].stories[]` to a backlog rail with Plan→Build→Review gates per story, walking-skeleton-first.

**Headline recommendation:** Phase 0–2 as MVP: stream file writes + Plan/Build toggle + Tier-1 Sandpack + story-by-story guided build with backlog rail. Defer Tier-2 HMR pod (Phase 3) and click-to-edit (Phase 4). Switch scaffold default to `vite-react-supabase`.

**Decisions you must make:**
- Approve the two-tier preview direction (Sandpack browser-only for everyday loop + Vite HMR pod on demand), keeping image build for go-live only?
- Switch new UI app scaffold default to **Vite + React + shadcn + self-hosted Supabase** (add `vite-react-supabase`, keep `nextjs-supabase` as option)?
- Kata/KVM availability on STACKIT for microVM isolation of Tier-2 preview pods — if unavailable, is gVisor/strict-container an acceptable fallback for Phase 3?
- Is Phase 0–2 (streaming + Plan/Build toggle + Tier-1 Sandpack + story-by-story build) the right first milestone, deferring Phase 3 (full-stack HMR) and Phase 4 (click-to-edit)?

---

## 5. Power BI Connector

**Status: report text to be re-surfaced.** This topic was researched in an earlier session but the transcript is not in the current set. The row is held here as a placeholder. Once the source transcript or notes are located, the report should be extracted and saved as `power-bi-connector.md` following the same format as the reports above.

---

*All four extracted reports are verbatim from completed agent transcripts. Date: 2026-07-19.*
