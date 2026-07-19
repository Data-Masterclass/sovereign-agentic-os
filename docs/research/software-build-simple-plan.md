# Software Build — the simple "governed frontend over the OS API" model

Supersedes the heavy two-tier/Kata plan in `software-build-lovable.md` for the DEFAULT app.
Decision (2026-07-19): an OS app is a **governed SPA that calls back into the Sovereign OS API**.
The OS *is* the backend. This deletes Kata/HMR/per-app-Supabase and makes preview instant + real.

## Model
- **Default app = Vite+React+shadcn SPA + the OS-client SDK.** No per-app backend/DB.
- The SDK calls the SAME governed routes the UI/MCP already use → every call is OPA/RLS-checked
  server-side and scoped to the grants the builder attached in Define. Governed by construction.
- **Preview = Sandpack (browser).** The SPA runs in the OS UI (same origin) so the user's session
  cookie flows → the SDK returns the user's REAL granted data in seconds (not mocks). Keep the
  existing build-image iframe as the optional "exactly what ships" check.
- **Publish = static build → nginx:8080** (immutable, sovereign). Existing image pipeline.
- **Escape hatch (rare):** an app needing real custom server logic flips to "full-stack" mode
  (Supabase edge fn / sidecar) + the slower build-image preview. Explicit, NOT the default.

## The OS-client SDK (`os-ui/lib/app-sdk/`, shippable as `@sovereign-os/app-sdk`)
A small typed TS client. Auth = ambient (same-origin session cookie in preview; a scoped app
session for the deployed app — see Open items). Methods wrap EXISTING governed routes (no new
governance): 
- `os.whoami()` → identity/role/domains
- `os.datasets.list() / .get(id) / .query(id, {sql?|nl?})` → `/api/data/*`
- `os.metrics.list() / .query(id, {dimensions?,filters?})` → `/api/metrics/*`
- `os.knowledge.search(q)` → `/api/knowledge/*`
- `os.files.list() / .get(id)` → `/api/files/*`
- `os.context()` → the app's granted context (datasets/metrics/knowledge/files/connections the
  builder attached) — drives the scaffold's starter page. (Add a thin `/api/app/context` if not
  already derivable; otherwise compose from existing list routes filtered by grants.)
Honest errors: 401 → "sign in", governed 403 → surface the server's reason. Never fake data.

## Scaffold (`os-ui/lib/software/scaffolds/vite-os/`)
Vite + React + TS + Tailwind + shadcn/ui, SDK pre-wired, a starter page that renders the app's
granted context + one live sample (a metric value or dataset preview via the SDK). Multi-stage
Dockerfile → nginx:8080. This is what `createApp` seeds and what the AI build generates against.

## Phases
- **1a (parallel, foundational):** the OS-client SDK + the Vite-OS scaffold. Ship.
- **1b:** wire the Software Build stage — `createApp` uses the scaffold; the AI build generates
  against the SDK; the Preview stage renders Sandpack wired to the real OS API (mock fallback).
- **1.5 (follow-up):** deployed-app cross-origin auth (the app at `<slug>.apps.<domain>` gets its
  own scoped OS session via the OAuth loopback/DCR path the MCP+CLI already use, or an OS proxy).
  Preview (same-origin) works without this; only the SHIPPED app needs it.
- **Later / escape hatch:** full-stack (Supabase) mode; element-click-to-edit; Claude Design import.

## Why this is simpler AND better
No Kata, no HMR pods, no per-app DB, no new stateful services. Preview shows REAL governed data
instantly. The app can only see what was granted (server-enforced). Deploy is static files.
