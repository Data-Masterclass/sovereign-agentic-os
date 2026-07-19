# Software-tab "Lovable-style" Build — Phase 1/2 implementation plan (deferred)

Phase 0 (shipped, see `components/software/SoftwareBuilder.tsx` `BuildStage`) delivered the fast-feel
inner loop with **no new infra**: a Plan⇄Build mode toggle, per-run before/after file diffs surfaced
inline, and a first-class story-targeted build with per-story status. Everything below needs an
infrastructure decision and is intentionally **deferred**. This file is the concrete plan for it.

Guiding constraints for all phases: sovereign/air-gapped by default (no external CDNs or SaaS in the
hot path), everything runs AS the signed-in user through the OPA-checked governed path, and the honest
live/offline-mock dual is preserved (never fabricate a running URL).

---

## Phase 1 — instant in-browser preview (no cluster round-trip)

### 1a. Sandpack instant preview
- Add `@codesandbox/sandpack-react` (self-hosted bundler assets, same air-gap treatment as Monaco —
  copy the bundler + template assets into `public/sandpack/` via a `scripts/copy-sandpack.mjs` invoked
  from `package.json` `prebuild`, mirroring `scripts/copy-monaco.mjs`).
- New in-lane component `components/software/SandpackPreview.tsx`: takes the app's committed file tree
  (already available via `/api/software/{id}/files` + the per-file GET) and mounts a Sandpack instance.
  Render it as a third pane in `BuildStage` behind a "Preview" sub-tab so it never competes with the
  code/chat panes on width.
- Wiring: after a Build run reports `changes`, hand the merged tree to Sandpack so the preview refreshes
  from the same changeset the diff view shows. No server round-trip; purely client bundling.
- Decision needed: which template Sandpack runs (static vs. node) — see 1b, because a Next.js app cannot
  run in Sandpack's browser bundler as-is.

### 1b. Vite + React + shadcn + Supabase scaffold generation
- The current template (`nextjs-supabase`, see `templateFiles` in `lib/software/apps.ts`) is server-rendered
  and cannot preview in-browser. Add a NEW template key `vite-react-supabase` to `AppTemplateKey` +
  `TEMPLATE_RUNTIME` (`'web'`), producing a client-only Vite + React + shadcn/ui + `@supabase/supabase-js`
  scaffold that Sandpack CAN run.
- Keep it additive and behind the create flow — do not change the default template for existing apps.
- Scaffold contents: `index.html`, `src/main.tsx`, `src/App.tsx`, a `components/ui/*` shadcn subset,
  `vite.config.ts`, and a Supabase client stub reading a governed anon key injected at preview time
  (never a raw secret in the tree — same grant model as today).
- Decision needed: shadcn component subset to vendor (full set is large); start with button/card/input/dialog.

---

## Phase 2 — live HMR pod + direct manipulation + external push

### 2a. Kata-isolated Vite HMR pod
- For apps too large/stateful for Sandpack, provision a per-app **Kata-isolated** dev pod running
  `vite --host` with HMR, fronted by the existing preview subdomain machinery
  (`app.subdomain`, the runner in `lib/software/runner.ts`).
- Reuse the honest live/offline-mock switch: when no cluster is reachable, fall back to Sandpack (1a).
- The pod mounts the app's repo (Forgejo) and watches `main`; a Build commit triggers HMR, so the
  preview updates within ~1s of `commitToApp`.
- Decision needed: pod lifecycle/GC policy (idle-timeout teardown), and Kata vs gVisor for the sandbox
  boundary given the cluster's existing runtime class.

### 2b. Element-click-to-edit (direct manipulation)
- Inject a tiny dev-only overlay agent into the preview iframe (Sandpack or HMR pod) that, on
  element click, resolves the clicked node back to its source range (React fiber → source location via
  the Babel `__source` transform) and posts `{ file, line, selector }` to the parent.
- BuildStage turns that into a pre-filled Build-chat prompt ("edit this button…") targeting the exact
  file — the click becomes a scoped Build request through the SAME governed chat route.
- Decision needed: source-map fidelity (need `@babel/preset-react` `development` + `@vitejs/plugin-react`
  with `jsxDev`), and how to keep the overlay out of production builds.

### 2c. Git / Jira push
- Add a fifth front door alongside the existing four in `lib/software/server.ts`
  (`authorThroughFrontDoor`): a **git-push OUT** that mirrors the app's Forgejo repo to an external
  remote (GitHub/GitLab), and a **Jira push** that turns Design epics/stories (now carrying per-story
  `status`) into Jira issues.
- Both are governed, Builder-gated actions filed as requests where promotion rules apply; credentials
  come from a governed Connection, never the browser.
- Decision needed: connection templates for the external Git host + Jira, and the mapping of the
  per-story `status` (`todo`/`building`/`done`) to Jira workflow states.

---

## Sequencing
1. Phase 1a+1b together (Sandpack needs a browser-runnable template) — biggest felt win, no cluster.
2. Phase 2a (HMR pod) once the sandbox runtime class is chosen.
3. Phase 2b (click-to-edit) on top of whichever preview is live.
4. Phase 2c (external push) last — it is a distribution feature, not part of the inner loop.
