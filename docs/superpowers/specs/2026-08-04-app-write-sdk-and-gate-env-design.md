# App write SDK (`os.records.*`) + gate production environment — design

Date: 2026-08-04 · Target: os-ui 0.6.61 → next · karpathy-guidelines

## Problem

1. The generated-app frontend SDK (`lib/app-sdk`) is READ-ONLY. Apps already have a
   governed WRITE path at the platform layer — each app carries `mcpTools` incl.
   `add_record`/`export_records` (write) under principal `app-<slug>`, and a
   Builder-APPROVED deploy envelope (`app.deploy.approved.writeTools`) listing which
   write tools may run live. But an app's own frontend has no door to that write path,
   so the build assistant has been hallucinating `os.datasets.update` / `os.files.create`
   for weeks (there is no real write surface to point it at).
2. The deployed compile gate reports "gate error — skipped, fail-open" on real commits:
   the `esbuild-wasm` `.wasm` binary is not traced into the Next standalone image (same
   class as the 0.6.61 type-libs bug). A missing wasm fails the WHOLE gate open, so
   hallucinated writes were never even caught by the tsc pass.

## Discovered architecture (verified, three agents + live probe)

- **There is no OS-side record store.** App "records" live in the deployed app's OWN
  backend. The MCP `add_record`/`list_records`/`get_record`/`export_records` tools are
  DECLARATIONS (template `mcpTools` + the app's committed OpenAPI `/records`), not OS
  handlers. They execute via `app/api/apps/[id]/tool/route.ts`: authorize the app
  principal → if the runner pod is live, PROXY to the app's in-cluster Service per its
  OpenAPI (`resolveToolOperation` + `callLiveApp`) → else return honestly-labelled
  `seedToolResult` (`source:'demo-seed'`). `app.dataArtifactId` is a metadata pointer
  (`spec:{app,table:'records',backend:'supabase'}`), not a rows store.
- **Envelope** = `app.deploy.approved: DeployEnvelope | null`, whose `writeTools:
  string[]` is the exact set a Builder signed off on for LIVE. Reads are always-on.
- **The SDK type is ALREADY closed.** Live probe: `compileGate` on a real `sovereign-app`
  tree with `os.datasets.update(...)` in a story returns TS2339 ("Property 'update' does
  not exist"). `createOsClient` is annotated `: OsClient` (a closed interface); the
  scaffold's `os` is `createOsClient()` whose inferred type is that closed interface.
  So the "hallucinations slid through" was NOT an open type — it was the gate FAILING
  OPEN in production (`gateEnvironmentReady()` returning not-ok, or the whole gate
  catching on a missing wasm and returning `gated:false`). Task 2 is the real fix; Task
  1.4 hardens the closure with a regression test so a future edit can't reopen it.

## Design

### Task 1 — the app write SDK (the bridge)

**One store, two doors.** Extract the tool-execution core from the `[id]/tool` route
into `lib/software/app-records.ts` (pure-ish, server-only): `executeAppRecordTool(app,
tool, args)` = the live-proxy-or-seed logic that route already runs. Both the MCP tool
route (unchanged behavior) and the new HTTP routes call it. No new store is invented;
the store stays the app's own service, and the SDK is a second door to the same
governed execution.

**Routes** — `app/api/apps/by-slug/[slug]/records/route.ts` (+ `[id]/route.ts` for
get-one), mirroring the members route (`withRoute`, `getAppBySlugForUser`, runs AS the
signed-in user):
- `GET  /api/apps/by-slug/{slug}/records`        → list  (entry-gated only)
- `POST /api/apps/by-slug/{slug}/records`        → add   (entry + envelope-gated)
- `GET  /api/apps/by-slug/{slug}/records/{id}`   → get   (entry-gated only)
- `POST /api/apps/by-slug/{slug}/records/export` → export(entry + envelope-gated)

Gates:
1. **Entry**: `getAppBySlugForUser(slug, user)` → 404 (honest "App not found") when the
   app is not visible to the caller. Identical to the members route.
2. **Envelope (writes only)**: the tool (`add_record` / `export_records`) must be in
   `app.deploy.approved?.writeTools`. If not → **403** with an honest reason naming the
   governance path: e.g. *"'add_record' is not in this app's approved deploy envelope —
   a Builder must approve it via request_deploy / the deploy review before the app can
   write. Reads work now."* Reads (`list_records`/`get_record`) are always-on once entry
   passes. A single helper `envelopeAllowsWrite(app, toolName)` centralizes this.

Route-level tool names are FIXED to the record convention (`list_records`, `add_record`,
`get_record`, `export_records`) — the SDK's four methods map 1:1, so the SDK never lets
an app name an arbitrary tool.

**SDK surface** (`lib/app-sdk/client.ts` + `types.ts`, vendored verbatim from disk by
`app-sdk-vendor.ts` — one source of truth, no second copy to sync):
```ts
os.records.list(): Promise<RecordList>
os.records.add(record: AppRecord): Promise<RecordAdd>
os.records.get(id: string): Promise<RecordGet>
os.records.export(): Promise<RecordExport>
```
Typed strictly (named result types, no bare `unknown` returns where a shape is known —
the server labels every result with `source:'live-app'|'demo-seed'`, which the types
carry). `AppRecord = Record<string, unknown>` (the app's own schema is open; the SDK is
an honest pass-through). Errors surface the server's honest reasons via the existing
`OsError`/`Forbidden` mapping — a 403 from the envelope gate becomes a `Forbidden`
carrying the reason verbatim.

The routes key off the frozen `APP_SLUG` the deployed app bakes in (same as members).
`APP_SLUG` is already a JS const in the sovereign-app scaffold (`src/template/app-meta.ts`).
Add an optional `appSlug` to `OsClientOptions`; the sovereign-app scaffold's
`src/core/store.ts` passes it (`createOsClient({ appSlug: APP_SLUG })`) — the shared
`src/os.ts` factory just forwards an optional slug through. If no `appSlug`, `os.records.*`
throw a local honest error ("os.records needs the app slug — createOsClient({ appSlug })"),
never a mystery 404.

### Task 1.4 — type closure regression

The `OsClient` interface stays closed and gains the `records` member. Add a compile-gate
test that runs the REAL `compileGate` on a `sovereign-app` tree with `os.datasets.update(
...)` in a story and asserts `ok:false` + a TS2339 diagnostic — locking the closure so a
future edit that loosens `createOsClient`'s return type (e.g. `: any`) is caught.

### BUILD directive (`chat-modes.ts`)

Replace any implication of dataset writes with the true surface: reads via
datasets/metrics/knowledge/files; WRITES via `os.records.*` ONLY, and only when the
app's approved envelope permits them. One line stating the exact import depth contract
(`import { os } from '../../../core/store'` from a story folder). One line: "a gate
rejection lists errors across ALL files — fix every listed file, not only yours."

### Task 2 — finish the gate's production environment

- **Diagnose**: `preview-runtime.ts` `getEsbuild()` → `esbuild-wasm` `initialize({worker:
  false})` loads `esbuild.wasm` from `node_modules/esbuild-wasm/esbuild.wasm` at runtime;
  `readEsbuildWasm()` reads the same file to serve the browser. Next's standalone tracer
  never sees this path (never `require()`'d) → the file is absent in the image → the
  bundle pass throws → `compileGate` catches → `gated:false` fail-open.
- **Dockerfile**: add explicit `COPY` of `node_modules/esbuild-wasm/esbuild.wasm` (and the
  package's `lib`/`bin` as needed to satisfy the exports resolution) into the standalone
  image, next to the type-libs copies added in 0.6.61.
- **Degrade the BUNDLE pass honestly, not the whole gate**: extend `gateEnvironmentReady()`
  to ALSO report the bundle asset. `compileGate` behavior: if the wasm asset is missing,
  the **tsc pass still gates** (that's the authoritative one that catches
  `os.datasets.update`), and only the bundle pass is skipped with an honest note ("bundle
  check skipped — esbuild asset missing"). A missing type-lib still degrades to
  `gated:false` (tsc can't run at all). This splits "env not ready" into "tsc-ready"
  (gate on tsc, skip bundle) vs "not even tsc-ready" (skip whole gate).

### Existing apps get the new SDK

The vendored SDK is READ FROM DISK at scaffold/heal time (`readSdkSource` → `sdkDir()`),
so there is no embedded copy to update — a re-vendor re-emits the current `lib/app-sdk`.
`healAppRepo` re-writes scaffold files; confirm it re-vendors the SDK (it seeds via the
scaffold path). If it does, existing apps pick up `os.records.*` on the next heal/reseed
from the app detail's existing refresh — document that path. If it does NOT re-vendor,
add a small `refreshVendoredSdk(appId)` used by that refresh. Verify which, then wire the
cheap path or note the manual one honestly.

## Testing

- Records routes: envelope-gated 403 (no approved `add_record`), entry-gated 404 (app not
  visible), and add/list/get/export happy paths (seed path, deterministic).
- SDK type closure: `compileGate` rejects `os.datasets.update(...)` (TS2339).
- `gateEnvironmentReady` bundle-asset degradation: missing wasm ⇒ tsc still gates, bundle
  skipped honestly; missing type-lib ⇒ whole gate `gated:false`.
- `tsc` clean; full suite green (worktree baseline + new tests).

## Non-goals

- No OS-side records database (records stay app-owned; that's the honest architecture).
- No change to the MCP tool route's behavior (it keeps calling the shared executor).
- No new governance semantics — the envelope + entry rules already exist; we add a door.
