# Software Build Stage — Lovable-style Preview / Hot-reload / Scaffold / Step-by-step Build

Date: 2026-07-19, status: advisory (decisions pending)

---

# Software Build Stage → Lovable-class experience, adapted for the Sovereign Agentic OS

A design/advisory report. Read-only — no code written. Every external claim is cited inline.

---

## 0. Where we are today (grounded in the code)

- **Build stage** (`components/software/SoftwareBuilder.tsx` `BuildStage`, ~line 738) is a 2-pane layout: an agentic build chat (`AgentChat` → `/api/apps/[id]/chat`) plus, for Builders, a `CodePanel` file editor, with a `TeamPanel` "delivery team" on top and an EPIC/story `<select>` build target.
- **The AI already runs agentically and sovereignly.** `/api/apps/[id]/chat` runs a PLAN→ACT harness over the `software` MCP tools; the model resolves through `lib/models/roles.ts` → LiteLLM gateway → STACKIT-managed sovereign models (Qwen3-235B reasoning, gpt-oss-20b exec), with a mock offline fallback. Nothing leaves the cluster.
- **Files are written by `commit`** (`lib/software/server.ts` `commitToApp`): a changeset is pushed to the per-app Forgejo repo (`apps.ts` `saveAppFile`/`forgejoApi`), merged into a snapshot, re-parsed for `app.yaml`/OpenAPI, and the auto-MCP profile is recompiled to OPA. Governed, audited via `trace()`.
- **Preview today = full container build.** `startPreview` (`lib/software/review.ts`) → CI (Forgejo Actions/DinD) builds an image → `runner.ts` provisions a real K8s Deployment+Service+Ingress and serves `https://<slug>.<domain>`. This is architecturally the **iframe-of-a-deployed-image** pattern (research option (c)) — correct and production-accurate, but **the slowest possible edit→render loop**: every change is a build+deploy cycle.

So we already have the sovereign agentic spine and the governed repo→image→serve pipeline. **The gap is purely the fast, magical inner loop** — streaming edits, an interactive preview that refreshes in seconds not minutes, click-to-edit, checkpoints, and a story-by-story guided build.

---

## 1. Anatomy of the Lovable-class experience

The "magic" reduces to three things confirmed across Lovable, Bolt.new, v0, Claude Artifacts, and Replit Agent: **(1) generation is streamed so it feels alive, (2) an interactive live preview sits beside the chat, (3) natural language is the primary edit surface** — you never leave the conversation ([v0 loop](https://mantlr.com/blog/what-is-v0-2026); [Bolt scaffolds/serves in one tab](https://github.com/stackblitz/bolt.new); [Artifacts iterate in plain English](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them); [Lovable agent loop](https://docs.lovable.dev/features/agent-mode)).

The interaction primitives (which we should selectively adopt):

| Primitive | What it is | Sovereign fit for us |
|---|---|---|
| **Streaming file writes** | Files appear/stream as generated | Easy — SSE, harness already streams |
| **Inline diffs / per-file review** | Review each change before/after commit | Easy — Forgejo diff + snapshot |
| **Element-click-to-edit** | Click a UI element in preview → edit it. Lovable "Visual Edits", v0 inline selection ([Lovable Visual Edits](https://lovable.dev/blog/introducing-visual-edits); [v0](https://mantlr.com/blog/what-is-v0-2026)) | Hard — needs preview-DOM↔source mapping; defer |
| **Error auto-fix loop** | Agent reads logs/build errors and iterates until green; Lovable claims ~90% fewer build errors ([Lovable agent mode](https://docs.lovable.dev/features/agent-mode)) | Medium — feed our build/HMR errors back into the harness |
| **Versioned checkpoints / rollback** | Snapshot code (+conversation, +DB) and restore in one click; Replit is the gold standard, bidirectional ([Replit checkpoints](https://docs.replit.com/core-concepts/agent/checkpoints-and-rollbacks)) | **We already have this** — git-backed versions (`listAppGitVersions`/`restoreAppGitVersion`) |
| **Chat-drives-edits** | NL is the primary edit surface | **We already have this** |
| **Repo sync** | GitHub/repo mirror | **We already have this** (per-app Forgejo repo) |

Lovable's mode split is worth mirroring because the Agents tab already has a Simple⇄Developer split: **Plan mode** (formerly Chat) deliberates and edits a plan with zero code changes; **Build mode** (formerly Agent/Default) executes end-to-end. Rule: "Plan mode is for decision-making. Build mode is for execution." ([Lovable agent mode](https://docs.lovable.dev/features/agent-mode)).

---

## 2. Preview / hot-reload options — matrix + sovereign recommendation

The three architectures and their trade-offs:

| Architecture | Edit→render | Runs real backend? | Sovereign/OSS | Notes |
|---|---|---|---|---|
| **(a) In-browser bundling** (Sandpack Apache-2.0; WebContainers proprietary) | Near-instant (no round trip) | No — browser ceiling; DB only via REST | Sandpack yes; WebContainers no (self-host only via paid Enterprise) | [Sandpack limits](https://sandpack.codesandbox.io/docs/resources/faq); [WebContainers enterprise](https://webcontainers.io/enterprise) |
| **(b) Server-side dev server in a sandbox** (Vite MIT HMR pod + Kata isolation) | **Sub-second HMR, real full-stack** | Yes | fully OSS, in-cluster | Fastest loop that runs *real* code; needs ingress+HMR wiring + isolation ([Vite in a pod](https://github.com/vitejs/vite/discussions/6473); [Kata RuntimeClass](https://northflank.com/blog/kata-containers-vs-firecracker-vs-gvisor)) |
| **(c) iframe of built/deployed image** (what we do now) | Slowest (build+deploy each change) | Yes | (already ours) | Production-accurate, most secure, cacheable ([Builder pattern](https://www.builder.io/c/docs/how-builder-works-technical)) |

Key sovereignty findings on the OSS building blocks:
- **StackBlitz WebContainers** — proprietary; commercial license required; on-prem only via sales-gated Enterprise. Not OSS. ([webcontainers.io/enterprise](https://webcontainers.io/enterprise))
- **Sandpack** — Apache-2.0, bundler self-hostable, but Nodebox can't run a real long-running backend/DB. Great for frontend-only previews. ([Sandpack FAQ](https://sandpack.codesandbox.io/docs/resources/faq))
- **Coder** — AGPL-3.0 community, K8s-native, Helm chart, 2025 AI-agent governance add-on. **Strongest sovereign K8s fit** for a workspace/execution control plane. ([coder community](https://coder.com/blog/coder-community-open-source))
- **e2b** — Apache-2.0 microVM sandboxes, but Nomad-based, GCP-GA/AWS-beta, **not K8s-native**. Off to the side. ([e2b infra](https://github.com/e2b-dev/infra))
- **Gitpod/Ona Flex** — abandoned Kubernetes, AWS-oriented; Classic self-hosted deprecated. Avoid. ([Gitpod left K8s](https://www.infoq.com/news/2024/12/gitpod-kubernetes-flex/))
- **Kata Containers + RuntimeClass** — Apache-2.0, opt individual pods into hardware-VM isolation with one `runtimeClassName` field; the sovereign-native way to isolate untrusted generated code in our cluster (needs KVM/bare-metal or nested-virt nodes). ([Kata + K8s](https://aws.amazon.com/blogs/containers/enhancing-kubernetes-workload-isolation-and-security-using-kata-containers/))

### Recommendation (sovereign-friendly)

**Adopt a two-tier preview, both in-cluster, no SaaS:**

- **Tier 1 — "Instant preview" (frontend-only, the everyday loop):** self-hosted **Sandpack (Apache-2.0)** rendering the generated **Vite + React + Tailwind + shadcn** SPA in the browser against **mock data / the typed API client**. Near-zero latency, nothing leaves the browser, trivially scalable. This is what makes generation *feel* like Lovable for 80% of edits (UI, layout, components).
- **Tier 2 — "Live app preview" (full-stack, on demand):** a **server-side Vite HMR dev-server pod (MIT)** per active session, exposed through ingress, running under **Kata RuntimeClass** isolation, wired to the app's self-hosted Supabase. Sub-second HMR against *real* code + DB. This replaces "rebuild the whole image to see a change."
- **Tier 3 — keep what we have:** the **full container build → runner → `https://<slug>.<domain>`** stays as the **production/go-live** artifact and the honest "this is exactly what ships" preview. It is no longer the inner loop.

Rationale: Tier 1 gives the magic feel cheaply and 100% sovereign; Tier 2 gives real full-stack fidelity without the build tax; Tier 3 (already built) remains the governed deploy. Coder is worth evaluating later as the Tier-2 control plane if we want managed, governed dev-workspaces per user, but a plain HMR pod + Kata is the simplest first cut.

---

## 3. Proposed Build-stage architecture (governed, sovereign)

```
┌─ Build stage UI (SoftwareBuilder BuildStage) ──────────────────────────────┐
│  Plan⇄Build toggle │ Backlog rail (core→epic→story) │ Chat │ Preview pane   │
└───────────────┬─────────────────────────────────┬──────────────┬──────────┘
                │ SSE stream (steps/diffs)         │ tool calls   │ preview URL
        ┌───────▼─────────┐              ┌─────────▼─────────┐    │
        │ Build harness   │  plan/act    │ software MCP tools│    │
        │ (existing chat  ├─────────────►│ commit / preview /│    │
        │  PLAN→ACT loop) │  LiteLLM     │ request_deploy    │    │
        └───────┬─────────┘  ▲           └─────────┬─────────┘    │
                │            │STACKIT               │ commitToApp  │
                │            │(Qwen3/gpt-oss)       ▼              │
                │       ┌────┴─────┐        Forgejo repo (per app) │
                │       │ LiteLLM  │              │ files          │
                │       └──────────┘              ▼                │
                │                        ┌─────────────────────┐   │
                └───────────────────────►│ Preview refresh svc │◄──┘
                                         │  T1 Sandpack (browser)
                                         │  T2 Vite HMR pod (Kata)
                                         │  T3 image build+runner
                                         └─────────────────────┘
   Every tool call: OPA-checked, runs as signed-in user, trace()'d (unchanged)
```

- **Where AI runs:** unchanged — LiteLLM → STACKIT sovereign models via the existing harness. We add *tighter agent instructions* (spec-driven sequencing, §4) and *stream the file writes/diffs* to the UI, not just prose.
- **How files get written:** unchanged governed path — the harness calls `commit` → `commitToApp` → Forgejo → snapshot → re-parse `app.yaml`/OpenAPI → recompile auto-MCP to OPA. **This is already the single choke point and it's already audited.** Net-new is only that the preview services *watch* the repo/snapshot to refresh.
- **How preview refreshes:** new **Preview-refresh service** with the 3 tiers above. On `commit`, T1 re-bundles in-browser instantly; T2's HMR pod pulls the changeset and hot-swaps modules; T3 (build) only runs on explicit "provision live preview" / go-live.
- **Governance stays intact:** preview pods run as the signed-in user under OPA, Kata-isolated, network-policied to only their own Supabase; go-live remains the Builder `decide_deploy` gate. Nothing about the security boundary changes.

---

## 4. Step-by-step assisted build (core → epic → story) as concrete UI states

Grounded in how spec-driven agentic tools sequence work: the universal loop is **plan → approve → execute one vertical slice → review → next**, gating at plan boundaries not per-tool-call ([GitHub Spec Kit: Specify→Plan→Tasks→Implement](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/); [AWS Kiro specs + EARS acceptance criteria + dependency "waves"](https://kiro.dev/docs/specs/); [Cursor: run steps one-by-one, atomic commit each, keep it runnable](https://cursor.com/docs/agent/plan-mode); [Devin: plan checkpoint + PR checkpoint](https://sureprompts.com/blog/devin-ai-prompting-guide)). The structural key to "runnable between steps" is **vertical slices, not horizontal layers**, starting with a **walking skeleton / tracer bullet** ([vertical vs horizontal](https://www.visual-paradigm.com/scrum/user-story-splitting-vertical-slice-vs-horizontal-slice/); [walking skeleton](https://agilealliance.org/glossary/story-mapping/)).

We already have the backlog: `App.epics[].stories[]` with `asA/iWant/soThat/acceptance`. That maps 1:1 to spec-driven "tasks with acceptance criteria." The UI is a **backlog rail** driving the harness:

- **State A — Scaffold the core ("walking skeleton").** One button: "Build core app." Harness generates the Vite+React+shadcn+Supabase skeleton (§5), commits it, and it must be **green + previewable** (Tier 1/2) before any story. Rail shows `Core ● building… → ● ready`.
- **State B — Backlog rail.** Left rail lists Core + every EPIC ▸ story, each with a status chip: `todo · planning · building · review · done`. This is the live task-list steering surface every agentic tool converges on ([Claude Code TODO](https://platform.claude.com/docs/en/agent-sdk/todo-tracking)). Ordered by dependency (walking skeleton → low-dependency/high-value → dependents → deferred).
- **State C — Plan gate (per story).** Select a story → harness enters **Plan mode**: emits a short plan (files it will touch, the vertical slice, how it satisfies the story's `acceptance`). **Zero code changes.** User edits/approves. Chip → `planning`.
- **State D — Build one slice.** On approve, **Build mode** executes just this story: streams file writes + inline diffs, commits atomically ("keeps the app runnable"), refreshes the preview. Chip → `building`. On build/HMR error, the auto-fix loop feeds the error back into the harness.
- **State E — Review gate (per story).** Diff + live preview + the story's acceptance criteria as a checklist. User **Accept** (chip → `done`, advance) or **Request changes** (stays, harness iterates). This is the "don't advance until validated" acceptance gate.
- **Resumability.** Because each story is an atomic commit, every increment is a git checkpoint (`restoreAppGitVersion` already exists). Close the tab, come back, the rail re-renders from `epics[].stories[]` status + git log; a paused build resumes exactly where it stopped. Use **tiered approval** (auto-approve safe/reversible, gate the irreversible) to avoid gate fatigue ([HITL tiers](https://machinelearningmastery.com/building-a-human-in-the-loop-approval-gate-for-autonomous-agents/)).

Net-new state we must persist: a per-story `status` + last-commit sha (extend `AppStory`), and a lightweight "current build session/phase" (TeamPanel already models phases: intake→plan→build→feedback→deploy).

---

## 5. Recommended FE + BE scaffold

**Generate: Vite + React + TypeScript + Tailwind + shadcn/ui (frontend) → self-hosted Supabase (backend).** This is the convergent AI-builder default and the most codegen-friendly, sovereign-cleanest choice.

- **Why Vite+React over Next.js for AI generation:** Next's App Router forces a `'use client'`/`'use server'` boundary that models frequently get wrong; a Vite SPA has one runtime where "every component follows the same rules," faster HMR, and deploys as plain static files. ~80% of AI-generated Next apps use zero SSR anyway. ([Vite vs Next.js](https://blog.vibecoder.me/vite-vs-nextjs-when-you-dont-need-framework)). This is also literally Lovable's and Bolt's default. ([Lovable stack](https://vibe-eval.com/guides/lovable-tech-stack/); [Bolt default](https://www.mindstudio.ai/blog/what-is-bolt))
- **Why shadcn/ui:** components are copied *into* the repo as visible TypeScript source (not hidden in `node_modules`), so the model reads/modifies/generates against real code — v0 made it the de-facto standard for AI UIs. ([Why AI tools love shadcn](https://www.shadcn.io/ui/why-ai-coding-tools-love-shadcn-ui))
- **Containerization:** build the SPA in a multi-stage Docker image, **serve static assets from nginx on a fixed port (8080)** — smaller attack surface, immutable artifact, clean FE/BE split that matches K8s multi-service assumptions, no RSC footguns. ([Vite SPA + nginx multi-stage](https://dev.to/it-wibrc/guide-to-containerizing-a-modern-javascript-spa-vuevitereact-with-a-multi-stage-nginx-build-1lma)). Our current scaffold is Next.js standalone serving on 8080 — workable, but the Vite SPA is the cleaner target for generation and for the split.
- **Backend — self-hosted Supabase:** Postgres + Auth + Storage + RLS + Realtime + Deno Edge Functions, standard Docker Compose / community Helm, **no telemetry / does not phone home** — sovereign by construction. Reach for a **Fastify/FastAPI sidecar only** for custom server logic beyond Edge Functions. ([Supabase self-hosting](https://supabase.com/docs/guides/self-hosting)). Note our scaffold already declares Supabase + RLS in `nextjsSupabaseTemplate`.
- **AI-friendliness rules for the scaffold:** consistent shadcn file layout; **single source of truth = the Supabase SQL schema**, with generated TypeScript types (`supabase gen types typescript`) flowing everywhere; **RLS on by default on every table** (the #1 Lovable/Supabase vuln is tables without RLS); and a **seeded example + green build as the floor** so a fresh generation always builds. ([AI-friendly scaffold guidance](https://vibe-eval.com/guides/lovable-tech-stack/))

**Concrete recommendation:** introduce a new `vite-react-supabase` template (FE = Vite SPA on nginx:8080, BE = Supabase) as the default for UI apps, keeping `nextjs-supabase` for teams that want SSR. Both flow through the identical `commitToApp` → CI → runner pipeline.

---

## 6. Phased implementation plan (MVP → full)

**Reuses existing pipeline:** LiteLLM/STACKIT agent harness, `commit`/`commitToApp` → Forgejo, snapshot + auto-MCP + OPA, git-backed versions/restore, CI→image→runner, `decide_deploy` gate, TeamPanel phases, EPIC/story model.

**Net-new** is flagged (⭑).

- **Phase 0 — Streaming feel (1–2 wk, mostly UI).** Stream file writes + inline diffs into BuildStage over SSE (harness already streams). Add the **Plan⇄Build toggle** (mirror Agents' Simple⇄Developer). No backend changes. *Reuses everything; ⭑ diff/stream UI only.*
- **Phase 1 — Tier-1 instant preview (2–3 wk).** ⭑ Ship the `vite-react-supabase` scaffold (§5) and ⭑ self-hosted **Sandpack** rendering the SPA against mock data in the browser. Instant "Lovable feel" for UI edits, fully client-side/sovereign. *Reuses commit pipeline.*
- **Phase 2 — Story-by-story guided build (2–4 wk).** ⭑ Backlog rail + per-story status/last-sha on `AppStory`; wire the plan-gate → build-one-slice → review-gate loop into the harness with spec-driven sequencing + walking-skeleton-first. *Reuses harness, git checkpoints, EPIC/story model.*
- **Phase 3 — Tier-2 live full-stack preview (3–6 wk, hardest).** ⭑ Preview-refresh service: per-session **Vite HMR pod** under **Kata RuntimeClass**, ingress + HMR-websocket wiring, network policy to its own Supabase, runs as signed-in user under OPA. Replaces "rebuild image to see a change." *Requires KVM/bare-metal nodes.*
- **Phase 4 — Polish primitives (ongoing).** ⭑ Error auto-fix loop (feed build/HMR errors back to harness), ⭑ element-click-to-edit (preview-DOM↔source mapping — the hardest primitive, defer), richer checkpoint UI over existing git versions.

---

## 7. Risks + honest hard parts

- **Tier-2 isolation needs KVM.** Kata microVM isolation requires bare-metal or nested-virt nodes on STACKIT; if unavailable, we fall back to gVisor/strict-container isolation + network policy, which is a weaker boundary for untrusted generated code. This is the single biggest infra dependency. ([Kata needs KVM](https://northflank.com/blog/kata-containers-vs-firecracker-vs-gvisor))
- **Per-session dev pods cost + scheduling.** A live HMR pod per active builder is real compute; needs idle-reaping, quotas, and per-tenant limits. Coder (AGPL) could manage this later but adds a control plane and copyleft considerations. ([Coder AGPL](https://coder.com/blog/coder-community-open-source))
- **Vite HMR through ingress is a known footgun.** `server.hmr.clientPort`/`host`/`allowedHosts` must be aligned or HMR silently fails; the dev server is unauthenticated so it must never be exposed without our auth/ingress + network policy. ([Vite HMR remote](https://github.com/vitejs/vite/discussions/6473))
- **Two scaffolds = maintenance.** Adding `vite-react-supabase` alongside `nextjs-supabase` doubles template surface (CI, Dockerfile, runner probe). Mitigate by making Vite the default and deprecating one over time.
- **Model quality on our sovereign tier.** Lovable/v0 lean on frontier models; Qwen3-235B/gpt-oss-20b will do multi-file spec-driven codegen less reliably. The **green-build floor + acceptance-criteria gates + auto-fix loop** are what make a weaker model usable — they're not optional polish, they're load-bearing.
- **Element-click-to-edit is genuinely hard** (bidirectional preview↔source mapping). Recommend deferring; the chat + Sandpack instant preview already delivers ~90% of the feel.
- **Sandpack ≠ real backend.** Tier-1 previews UI against mocks, not live Supabase; users must understand Tier-1 = "looks right," Tier-2/3 = "works right." Label honestly (consistent with the OS's existing honest-degradation ethos).

---

## Decisions I need from you (3–5)

1. **Two-tier preview — approve the direction?** Sandpack (browser, instant, frontend-only) for the everyday loop + Vite-HMR-pod (Kata-isolated, full-stack) on demand, keeping the current image build strictly for go-live. Yes / adjust?
2. **Scaffold default:** switch new UI apps to **Vite + React + shadcn + self-hosted Supabase** (add `vite-react-supabase`, keep `nextjs-supabase` as an option)? Or stay Next.js standalone?
3. **Kata/KVM availability on STACKIT:** can we get bare-metal / nested-virt nodes for microVM isolation of Tier-2 preview pods? If not, are you OK with a gVisor/strict-container fallback for Phase 3?
4. **Scope of MVP:** is the Phase 0–2 slice (streaming + Plan/Build toggle + Tier-1 Sandpack + story-by-story guided build) the right first milestone to ship, deferring the full-stack HMR pod (Phase 3) and click-to-edit (Phase 4)?
5. **Build me a written execution plan next?** If you approve the above, I'll turn Phases 0–2 into a concrete implementation plan (files, data-model deltas on `AppStory`, new routes/services) via the plan workflow.

**Key files for implementation reference:** `components/software/SoftwareBuilder.tsx` (BuildStage ~L738), `lib/software/apps.ts` (App/AppEpic/AppStory model, Forgejo I/O, git versions), `lib/software/server.ts` (`commitToApp` — the governed write choke point), `lib/software/review.ts` + `lib/software/runner.ts` (preview/deploy), `app/api/apps/[id]/chat/route.ts` (agentic harness), `lib/models/roles.ts` (LiteLLM/STACKIT model resolution), `app/software/TeamPanel.tsx` (phase-driven build conversation).
