# Software Deploy Pipeline — Re-derivation & Redesign

Status: PROPOSED (decision document, no code changed)
Date: 2026-08-03
Owner decision required: yes — see "Key decisions the owner must make" at the end.
Scope: the whole "AI-generated code → running governed app" chain in `os-ui/`.

> The platform owner has stopped incremental fixes ("as before with the metric app").
> This document re-derives the pipeline step by step, evaluates alternatives honestly,
> and recommends a staged plan. It keeps the OS invariants: the governance ladder
> (Personal → Shared → Certified), run-as-user + OPA, honesty (no fabricated status),
> and sovereignty (everything self-hosted, no external deps).

---

## 0. The chain today (verified in code)

```
Design (specs)
  → Build agent  (STANDARD-tier LLM writes .tsx)          lib/software/chat-modes.ts, app/api/apps/[id]/chat/route.ts
  → commitToApp  (per-file Forgejo contents-API PUT/POST) lib/software/server.ts
  → Forgejo repo (+ durable OpenSearch mirror)            lib/software/file-mirror.ts (snapshot.ts)
  → Forgejo Actions (DIND ci-runner): npm build →         scaffolds/vite-os.ts dotforgejoWorkflow()
        docker build → push :latest + :sha12 → in-cluster registry
  → k8s runner Deployment (imagePullPolicy Always,        lib/software/runner.ts
        rolls only on pod-template change via deployed-at annotation)
  → Service + Ingress → per-app subdomain URL
  → Approve & go live (governance ladder)                 lib/software/review.ts, lifecycle.ts
```

Two facts from the code frame everything below:

1. **The compiler is minutes away and off-thread.** The build turn ends, `commitToApp`
   returns success on a *landed commit* (not a *compiling* one), and Forgejo Actions
   runs `npm run build` asynchronously. The result is polled on page load
   (`apps.ts` ~L1807 `actions/tasks`) and shown honestly — but it is **never fed back
   into the agent**. This is failure-class #1 and #4, and it is structural, not a bug.

2. **The pieces for a shorter path already exist in-tree.** `preview-runtime.ts` +
   the Instant Preview already bundle the app's own `src/*` with **esbuild-wasm**
   (same-origin, zero CDN egress) and run it as a single React instance. `sections-registry.ts`
   already makes nav registration deterministic. `k8s.ts` is a generic
   method/path/body client that can already POST `batch/v1` Jobs and watch pods.
   The redesign is mostly *rewiring existing capabilities into the critical path*,
   not green-field building.

---

## 1. Step-by-step verdict table

For each step: what it is for · what has failed · on the critical path for the user's
goal (describe → working governed app)? · simplest design that keeps the goal.

| # | Step | For | What has failed | On critical path? | Simplest design that keeps the goal |
|---|------|-----|-----------------|-------------------|--------------------------------------|
| 1 | **Code generation + verification** | Turn spec → compiling `.tsx` using the vendored UI/SDK | Hallucinated APIs (Badge `variant`→`tone`, unimported Button/React, wrong `../../` depth). BUILD directive already enumerates UI 0.6.20 API and it *still* happens. **Compile feedback never reaches the agent.** | **YES** — this is where the goal is won or lost | **Verify-before-commit**: run tsc/esbuild against the vendored UI/SDK types *inside the build loop*; the agent iterates on real compiler errors and only compiling code is allowed to commit (Alt A). |
| 2 | **Source of truth for app source** | Durable, exportable record of the app tree | Repo deleted / DB-desynced (adopt-heal 0.6.57); files lived only in Forgejo + in-proc snapshot (durable mirror 0.6.56); sha-422 no-op commits (0.6.51). | Partly — a *durable* source of truth is essential; **Forgejo being that source is not** | Make the **durable OpenSearch mirror the authoritative tree**; Forgejo becomes a git *projection/export*, not the read path. `commitToApp` already writes the mirror after its honesty gate. |
| 3 | **Build / image production** | Compile the SPA and produce a servable artifact | Async, invisible, DIND-in-Forgejo-Actions is a long, fragile critical-path hop; `:latest` needs an explicit roll; ImagePullBackOff class (#5). | Only if we insist on a **per-app container image** | Either (B) an **in-cluster BuildKit/Kaniko Job** os-ui triggers synchronously and pins a **digest**, or (D) **no per-app image at all** — serve the bundled tree from one shared runtime. |
| 4 | **Deployment / serving** | Actually serve the app at a URL under governance | Runner not provisioned on transient k8s outage (self-heal 0.6.52); `:latest` + template-annotation roll dance; stale-image serving. | **YES** — something must serve it | Digest-pinned runner (B) *or* one shared, sandboxed **app-runtime** that loads story pages as data (D). Either removes the `:latest` roll ambiguity. |
| 5 | **Governance (preview → approve → live)** | The Personal→Shared→Certified ladder, run-as-user, OPA, review gate | Largely sound; the failures were *upstream* (nothing to approve, or approving a red build). | **YES** — invariant, keep | **Keep as-is.** Governance gates the *artifact*, not the transport. It is orthogonal to steps 1–4 and must survive every alternative unchanged. |
| 6 | **Status truth** | Never claim a state the cluster/compiler didn't confirm | Was self-reported (earned-status 0.6.54); honest now *because the chain is too long to trust implicitly*. | **YES** — invariant, keep | **Keep honesty; shorten what must be trusted.** Every step below reduces the number of async, unverifiable hops status has to narrate. |

**Derivation conclusion.** The user's goal is *describe → working governed app*. Steps 5
and 6 are invariants and are healthy. Steps 2, 3, 4 are *implementation of transport* and
are where fragility lives. Step 1 is where **correctness** is won — and it is the one step
with **no feedback loop at all**. The highest-leverage change is to close the loop at step 1
(compile-in-loop) and to collapse steps 2–4 from a 6-hop async chain into the shortest path
that still yields real, exportable code.

---

## 2. Alternatives — honest trade-offs

Scored 1–5 (5 = best) on: eliminates-failure-classes · simplicity · sovereignty · low-effort ·
migration-path · keeps-real-exportable-code.

### A. Verify-before-commit (in-process compile/typecheck in the build loop)
The agent's generated tree is type-checked/bundled **in-process** (esbuild for a fast
transpile+bundle error pass; optionally `tsc --noEmit` against the vendored `@sovereign-os/ui`
+ `@sovereign-os/app-sdk` types) *before* `commitToApp` accepts it. Errors are returned to the
same build turn as a tool result; the agent iterates until it compiles. CI becomes
*confirmation*, not *discovery*.

- Eliminates: **#1 entirely** (hallucinated APIs, bad imports, wrong depth all surface in-loop),
  and drains most of #4 (a failed CI run becomes the rare case, not the norm).
- We already run esbuild-wasm in Node (`preview-runtime.ts`) and already ship the exact UI type
  surface the errors need — so the "compiler" is largely present.
- Trade-off: esbuild bundling catches *resolution + syntax + missing-export* errors fast but is
  **not a type checker**; `variant` vs `tone` is a *type* error, not a resolution error. To catch
  those we need `tsc` against the vendored `.d.ts`/types (slower, ~seconds) OR a curated
  lint/allowlist pass over the known UI/SDK API. Recommend: esbuild gate always (cheap, blocks the
  worst), `tsc` pass as the authoritative gate for the UI/SDK primitive misuse.
- Scores: failure-cover **5** · simplicity **4** · sovereignty **5** · effort **4** · migration **5** · real-code **5**.

### B. Direct build service (drop Forgejo Actions from the critical path)
os-ui triggers an **in-cluster BuildKit/Kaniko `batch/v1` Job** from the durable mirror tree,
**watches it synchronously**, pushes a **digest-tagged** image, and deploys the runner
**digest-pinned**. Forgejo stays for git history/export, off the serving path.

- Eliminates: the DIND-in-Actions hop, the `:latest` roll dance and stale-image class (#5),
  and the async-invisibility of the *build* half of #4 (os-ui watches the Job directly).
- `k8s.ts` already supports POST/GET on arbitrary paths incl. `batch/v1`; `runner.ts` already
  digest-agnostic (just feed it the digest ref instead of `:latest`).
- Trade-off: os-ui now owns a build orchestrator (Job spec, log capture, timeout, cleanup) and
  in-cluster registry auth moves into os-ui. Still a container build per app (minutes, cache-cold).
- Scores: failure-cover **4** · simplicity **3** · sovereignty **5** · effort **3** · migration **4** · real-code **5**.

### C. CI-repair loop (failed CI → automatic bounded repair build turn)
A red CI run feeds its error log back into an automatic, **bounded** repair build turn (reuse the
existing 0.6.54 bounded-escalation machinery). The loop that step 1 lacks, bolted onto step 3.

- Eliminates: the standing-red-run half of #4 — no failed run "just sits red".
- Cheap to add; purely additive; no transport change.
- Trade-off: it is a **slow, expensive** version of A — each iteration is a full CI round-trip
  (minutes) instead of an in-loop compile (seconds), and it repairs *after* a dishonest-feeling
  gap. It is the right *safety net* but the wrong *primary* mechanism. Best value **on top of A**
  (A catches 95% in-loop; C catches the rest — genuine env/build-only failures — automatically).
- Scores: failure-cover **3** · simplicity **4** · sovereignty **5** · effort **4** · migration **5** · real-code **5**.

### D. No-image runtime (the biggest simplification)
Stories run as **data** in one shared, sandboxed **app-runtime** (a single platform image).
Story pages are loaded dynamically from the durable mirror, bundled (esbuild), and rendered
sandboxed. **No per-app CI, image, registry entry, or pod.** Repo/CI becomes an *optional export
product*, not the serving path.

Feasibility against what exists: the Instant Preview **already does exactly this** — it bundles
the app's `src/*` with esbuild-wasm and runs it same-origin as a single React instance
(`preview-runtime.ts`, `preview-shape.ts` — Vite-shaped apps only, which is the sovereign-app/
vite-os default). Promoting that from "preview" to "the serving path" is the core of D.

- Eliminates: **#2, #3, #5 as failure surfaces disappear entirely** (no repo-on-critical-path,
  no image build, no registry, no per-app rollout). #4 shrinks to "did the bundle compile" — which
  A answers in-loop. This is the only option that deletes whole *classes* rather than hardening them.
- Trade-off (the honest hard parts):
  - **Isolation.** One runtime serving many tenants' generated code needs real sandboxing.
    Client-side eval (per-app iframe, strict CSP, no ambient cross-app token) is the pragmatic
    sovereign answer and matches the current same-origin preview model; **server-side SSR of
    untrusted generated code in a shared process is a no-go** (RCE/cross-tenant). Decision hinges
    on client-eval-in-iframe being acceptable for "live" (it already is for preview).
  - **Resource limits.** Per-app CPU/mem quotas that a shared pod gave for free must now be
    enforced in-runtime (bundle size caps, timeouts). Coarser than a per-pod cgroup.
  - **Runtime API breadth.** Anything a raw nginx-served SPA could do that the SDK doesn't cover
    must go through the SDK (which is already the invariant — governed frontends have no custom
    backend). Apps that need a *custom server* (api-service template) cannot use D and stay on B.
  - **Export parity.** The exported repo must build to the *same* result as the runtime renders,
    or "real exportable code" becomes a lie. The scaffold Dockerfile/CI must remain a faithful
    projection — tested, not assumed.
- Scores: failure-cover **5** · simplicity **5** (at runtime) / **2** (isolation design) · sovereignty **5** · effort **2** · migration **3** · real-code **4** (exportable, but the *serving* artifact is data, not the image).

### E. Combinations
- **A + B + digest-pinning** — evolution. Keep per-app images, but make them *correct*
  (A) and *deterministic* (B digest). Lowest-risk path that still deletes the worst classes.
- **D + A for exports** — revolution. Serve from the shared runtime (D); when a user wants a
  real artifact, generate + build the repo (A-verified) as an *export/certify* action, off the
  hot path. This is the end-state that reconciles "no per-app image" with "keeps real exportable code".

---

## 3. Failure-class coverage matrix

Rows = documented failure classes; cells = does the alternative eliminate (E), reduce (r), or
not address (–) that class.

| Failure class | A verify-before-commit | B direct build | C repair loop | D no-image runtime |
|---|---|---|---|---|
| #1 Generated code doesn't compile / hallucinated API | **E** | – | r (slow) | r (A still needed for the bundle) |
| #2 Commit fragility (sha-422, empty args, budget) | – | r (mirror-as-source) | – | **E** (mirror is the source; git optional) |
| #3 Forgejo as critical path (orphan/desync/durability) | – | r (off build path) | – | **E** (off serving path) |
| #4 Async CI invisibility / no repair loop | r (CI becomes rare) | r (sync build watch) | **E** (auto repair) | **E** (compile is the only gate, in-loop) |
| #5 Runner fragility (`:latest` roll, ImagePullBackOff) | – | **E** (digest-pinned, sync) | – | **E** (no per-app pod/image) |
| #6 Self-reported status | – (keep honesty) | r (fewer hops to narrate) | r | **E** (few hops left to mis-narrate) |

No single option covers everything. **A** owns #1. **D** owns #2/#3/#5 by deletion. **C** owns #4.
That is why the recommendation is staged and combinatorial, not a single pick.

---

## 4. RECOMMENDATION (staged)

**Adopt A now, C next, evolve toward D — keep governance (5) and honesty (6) untouched throughout.**

### Week 1 — A: Verify-before-commit (highest leverage, lowest risk)
- Add an in-process compile gate in `commitToApp` (`lib/software/server.ts`), before the honesty
  gate: bundle the merged tree with esbuild (reuse the `preview-runtime.ts` esbuild-in-Node setup)
  and run a `tsc --noEmit` pass against the vendored `@sovereign-os/ui` + `@sovereign-os/app-sdk`
  types. On error, **do not commit**; return the compiler diagnostics as the tool result so the
  build turn iterates (the harness already supports multi-step tool loops + bounded escalation).
- Update the BUILD directive to state the contract: "your commit is rejected unless it compiles;
  you will receive the exact errors — fix and retry." (`chat-modes.ts`).
- Net effect: failure-class #1 is closed *in-run*; CI becomes confirmation. This alone addresses
  today's `app_on1hxye3ocl` class of failures.

### Week 2–3 — C: CI-repair loop (safety net for what A can't see)
- When the on-load CI poll (`apps.ts` actions health) reports a *build-time* failure that A
  couldn't catch (genuine env/deps), auto-open one bounded repair build turn seeded with the CI
  log. Reuse the 0.6.54 escalation budget. Keep it bounded and honest (mark the turn, no infinite loop).

### Month 2 — B + digest-pinning: make the image path deterministic
- Replace the Forgejo-Actions DIND build on the critical path with an in-cluster BuildKit/Kaniko
  `batch/v1` Job os-ui submits and watches (via the existing `k8s()` client), pushing a
  **digest**. Feed the digest to `runner.ts` (`appImageRef` → digest ref) and drop the
  `deployed-at`-annotation roll hack + `imagePullPolicy: Always` reliance. Forgejo Actions
  remains available for *export* builds, off the hot path.

### Quarter 2 — D (behind a flag): shared app-runtime as the serving path
- Promote the Instant Preview runtime to a first-class, sandboxed **app-runtime** (one platform
  image) that renders any Vite-shaped sovereign-app from the durable mirror in a per-app iframe
  with strict CSP and no cross-app ambient token. Per-app image build becomes an *export/certify*
  action (A-verified), not a prerequisite to "live". Ship behind a flag; migrate opt-in.
- Gate D on the isolation decision (below). api-service (custom-server) apps stay on B forever.

---

## 5. What gets DELETED from the current chain

Immediately (with A):
- The tolerance for non-compiling commits — a rejected-because-uncompiling path replaces the
  "commit lands, CI discovers the break minutes later" gap.

With B:
- **Forgejo Actions DIND on the critical path** (`dotforgejoWorkflow` stays only as an export
  projection).
- The **`:latest` floating tag as the serving ref**, and with it the **`deployed-at` pod-template
  annotation roll hack** + reliance on `imagePullPolicy: Always` to defeat the node image cache
  (`runner.ts` `buildDeploymentManifest`). Replaced by digest-pinning.

With D (end-state):
- **Per-app CI, per-app image, per-app registry entry, per-app Deployment/Service/Ingress** for
  Vite-shaped governed frontends. The in-cluster registry prune logic, `appImageRef` `:latest`
  convention, and the runner reconcile-roll all fall away for those apps.
- **Forgejo as anything other than an optional git export** — the durable mirror becomes the
  single source of truth for source (step 2).

Never deleted (invariants): the governance ladder + review gate (`review.ts`, `lifecycle.ts`),
run-as-user + OPA (auto-MCP compile in `commitToApp`), honest status (`pipeline-honesty`,
earned-status), and full sovereignty (esbuild-wasm/BuildKit/Kaniko/registry all self-hosted).

---

## 6. Migration path for existing apps

- **A** is transparent to existing apps: the next build turn simply also compiles. Nothing to
  migrate; already-committed non-compiling trees surface honestly on their next edit.
- **B**: existing apps keep serving their current `:latest` image until their next deploy, which
  produces a digest and repins the runner. Migration is lazy, per-deploy, reversible (the Forgejo
  Actions workflow still exists).
- **D**: opt-in behind a flag. An app "moves to runtime" by having its mirror tree rendered by the
  shared runtime instead of its pod; its pod/image/repo can be torn down (reuse `deleteApp` runner
  teardown in `lifecycle.ts`) *after* the runtime serves it — verified, honest, never a gap.
  api-service and any legacy Next.js-scaffold apps (detected by `preview-shape.ts` → `nextjs`)
  are **excluded** and remain on the image path (B). Governance visibility/ownership is unchanged
  — D changes transport, not the artifact's place on the ladder.

---

## 7. Key decisions the owner must make

1. **Compile authority for step 1 (A).** esbuild-bundle gate only (fast, catches resolution/
   syntax/missing-export), or **also** `tsc --noEmit` against vendored UI/SDK types (slower ~sec,
   the only thing that catches `variant`-vs-`tone` primitive-API misuse)? Recommend: both — esbuild
   always, tsc as the authoritative UI/SDK gate.

2. **Image vs no-image end-state (B vs D).** Is the strategic target a *correct, deterministic
   per-app image* (B, evolution) or *no per-app image at all* (D, revolution)? This decides whether
   Month-2 work hardens the image path or begins dismantling it. Recommend: B as the near-term
   floor, D as the declared end-state behind a flag.

3. **Isolation model for D.** Is **client-eval in a per-app iframe with strict CSP** (the current
   preview model, promoted to "live") an acceptable isolation boundary for multi-tenant live serving?
   If server-side isolation is required instead, D's cost rises sharply and B becomes the end-state.

4. **Forgejo's role.** Demote Forgejo to an *optional git export/history projection* (durable mirror
   becomes the source of truth), or keep it as an authoritative store? Recommend: demote — it has
   been the single largest source of critical-path fragility (#2, #3).

5. **CI-repair autonomy (C).** May the platform spend a bounded, automatic model budget to repair a
   red build without a human in the loop, provided every such turn is honestly marked? Recommend:
   yes, bounded + labelled — it is the honest completion of the loop step 1 lacks.
