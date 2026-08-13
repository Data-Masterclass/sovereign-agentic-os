/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import {
  createApp,
  getAppByIdInternal,
  getAppForUser,
  patchAppDesign,
  setAppSpec,
  serveModeOf,
  listAppFilesForViewer,
  readAppFileForViewer,
  withStatus,
  type AppEpic,
  type AppTemplateKey,
} from '@/lib/software/apps';
import { describeApp } from '@/lib/software/appspec/describe';
import { normalizeContextGrants } from '@/lib/core/context-grants';
import { promoteThroughSeam } from '@/lib/governance/ladder';
import { trace } from '@/lib/infra/agent-governed';
import { startPreview, requestDeploy, decideDeploy } from './review.ts';
import { archiveApp, deleteApp, useAsData, consumeResource } from './lifecycle.ts';
import { authorThroughFrontDoor, commitToApp } from './server.ts';
import type { ConsumedResource, SurfaceDeclaration } from './model.ts';
import { asBuildTarget, buildGate, stageDirective, targetProgress, resolveTarget } from './mcp-stages.ts';
import { resolveGrantedContext } from './grants-context.ts';
import { normalizeImprovement, type Improvement } from './improvements.ts';
import { codedAppsEnabled } from '@/lib/platform-admin/settings';
import { PATTERNS, PATTERN_IDS, isImplementedPattern } from './appspec/patterns.ts';
import { generateAppSpecForApp } from './appspec/generate-server.ts';

/**
 * The IMPLEMENTED cookbook patterns, sourced from the authoritative registry
 * (`patterns.ts`) so a tool description can never drift from the validator. Split
 * by shelf (VIEW reads · INTERACTIVE writes via `os.records`) for the set_app_spec
 * description — each is a compact "`id` (what it does)" list.
 */
export const IMPLEMENTED_PATTERN_LIST: { view: string; interactive: string } = (() => {
  const line = (category: 'view' | 'interactive') =>
    PATTERN_IDS.filter(isImplementedPattern)
      .filter((id) => PATTERNS[id].category === category)
      .map((id) => `\`${id}\` (${PATTERNS[id].description.replace(/\.$/, '')})`)
      .join(', ');
  return { view: line('view'), interactive: line('interactive') };
})();

/**
 * THE PLATFORM MCP — front door #2, and the GOVERNANCE INVARIANT this build's
 * security rests on (Software golden path — Governance invariant):
 *
 *   The Platform MCP gives full capability PARITY with the UI, governed
 *   IDENTICALLY — same delegated identity, roles, golden-path procedures,
 *   capability profiles, approvals/deploy-review, lineage, audit. It is a FRONT
 *   DOOR, NEVER A BACK DOOR: it must not bypass roles, reviews, OPA, egress/
 *   secrets, or the transparency gate.
 *
 * HOW THE INVARIANT IS ENFORCED BY CONSTRUCTION: every tool here delegates to
 * the EXACT SAME governed library function the UI route calls, passing the
 * caller's delegated `CurrentUser` (never a service identity). There is NO
 * privileged path. Therefore:
 *   • a Creator calling `promote` gets the same 403 as in the UI (role gate);
 *   • `request_deploy` opens the SAME Builder review card — the MCP cannot
 *     self-approve a go-live (only `decide_deploy`, role-gated to a Builder, can);
 *   • a consumed resource is recorded as a reference, never a raw credential;
 *   • every call is Langfuse-traced with the caller's identity.
 *
 * This is asserted explicitly in `software.platform-mcp.test.ts`.
 */

export const PLATFORM_MCP_PRINCIPAL = 'platform-mcp';

/**
 * The MCP tool surface — parity with the UI's five governed stages (0.6.105 restructure):
 *   Define App     → create_software
 *   Design Epics   → design_software  (author the epic/story/spec tree)
 *   Choose Context → design_software  (bind existing via `grants`) + create_dataset / data-plan
 *                    for CREATE-NEW datasets — the data-need gate is resolved here. NOTE:
 *                    Choose Context has no dedicated MCP verb in this wave; it is expressed
 *                    through `design_software` (grants) — a fuller "resolve_context" verb is a
 *                    deliberate FOLLOW-UP.
 *   Build App      → build_software   (unit-scoped, design-before-build + data-need gated)
 *   Test & Publish → verify_software (5-dimension verification → refinements), then
 *                    request_deploy / decide_deploy / promote (governed, role-gated)
 *
 * Tool NAMES are stable across the 0.6.105 rename — only the stage LABELS/descriptions moved.
 * The STAGED tools are the advertised default path — an external agent walks the identical
 * governed flow to the UI. `commit` remains as a DEVELOPER-MODE escape hatch (raw file write,
 * role-gated to builder/admin) for the deliberate exception.
 */
export const PLATFORM_MCP_TOOLS: { name: string; description: string; write: boolean }[] = [
  // ---- Define App ----
  { name: 'create_software', description: "STAGE 1 · DEFINE APP. Create a new governed app. DEFAULT `kind: 'spec'` — a DECLARATIVE app: a validated AppSpec of cookbook-pattern tabs over governed data, served SAME-ORIGIN by the OS renderer (NO Forgejo repo / CI / registry / pod), authored with set_app_spec or scaffolded in one call with generate_app_spec. This is the golden path. Pass `name`, an optional `domain`, an optional `purpose` (the app's stated intent, ≤2000 chars), and optionally DECLARE its surface (surface: 'ui' | 'api' | 'both') — declaring wins over auto-detection. `kind: 'code'` is the ADVANCED coded path (raw code + Forgejo + image build) — it is DISABLED by default and only works when a platform admin has enabled coded apps (createApp fails closed with 403 otherwise). The `template` arg (`sovereign-app` default, `website`, `api-service`, `empty`) only shapes a coded app's scaffold. Next: design_software.", write: true },
  // ---- Design Epics (+ Choose Context via `grants`) ----
  { name: 'design_software', description: "STAGE 2 · DESIGN EPICS (and STAGE 3 · CHOOSE CONTEXT). Author or update the app's specification tree — `purpose`, `epics` (each with user stories and per-story `spec` of features / non-functional requirements / rules), and governed context `grants` (bind existing connections / data / knowledge / files / metrics — this is the Choose Context bind-existing surface). This is the SAME governed write the UI uses (patchAppDesign): owner / owning-domain admin / platform admin only. A story must have a spec AND, if it needs data, a bound/created dataset before build_software will build it (the design-before-build + data-need gates). Next: build_software.", write: true },
  // ---- Build App ----
  { name: 'build_software', description: "STAGE 4 · BUILD APP. Build a SPECIFIC unit — the whole app, one `epic`, or one `story` (pass `target`) — from its FINALIZED Design spec and its ALREADY-GRANTED context. Context (datasets / knowledge / metrics / connections) is bound or created earlier in CHOOSE CONTEXT (design_software `grants` + create_dataset) — build WRITES CODE against that frozen, injected schema; it does NOT discover, list or query data. Enforces the design-before-build gate (refuses stories with no spec, naming them), and returns the governed BUILD directive + Define context + the granted-context schema + the target's spec + the code-structure convention (write each story under src/epics/<epic>/<story>/, src/App.tsx/main.tsx stay thin) + the current committed files and honest built-vs-pending progress. You then author the code and call `commit` — a story counts as BUILT only after its files land in a SUCCESSFUL commit (an empty/failed commit builds nothing), never from a status you set by hand. DATA IS PRESENT ⇒ BUILD IT: when the returned granted-context block carries dataset columns, the data need is ALREADY MET — build against those columns; do NOT refuse or claim the app has no data (the grant IS the authorization, resolved as you). ONLY when the granted-context block is genuinely empty of the dataset a story needs, go back to Choose Context and grant/create it — do not try to discover data from Build, and do not dead-end. VENDORED-API CONTRACT (the returned directive spells it out; breaking it FAILS the compile gate): a page imports ONLY from `react`, `@sovereign-os/ui` and the OS `os` client — NEVER `react-router-dom`/any router or other 3rd-party lib (no client-side router; navigation is the auto-registered section page), and a story page returns its CONTENT (`<Section><Card>…`) and NEVER renders `<AppShell>` (template-only; it requires `nav`) — mirror src/template/pages/Overview.tsx. \"DONE\" = status:'done' AND committed files, NEVER the spec: asked to build a story that is not done and has no files, BUILD IT — never reply \"already implemented / no further build needed\" or recite acceptance criteria as proof; `read_app_files` its path if unsure. ROLES: `useIdentity()` returns IdentityState — a DISCRIMINATED UNION with `.phase` ({phase:'loading'}|{phase:'signed-out'}|{phase:'error',message}|{phase:'ready',user}), NO `id` field; never `const { id } = useIdentity()`, never `.id`, never `.user` without narrowing `.phase === 'ready'` first. Copy exactly (mirror src/template/pages/Overview.tsx): `const identity = useIdentity(); const user = identity.phase === 'ready' ? identity.user : null; const canEdit = !!user && roleAtLeast(user.role, 'domain_admin');`. Gate with `roleAtLeast(user.role, '<floor>')` from src/template/roles.ts — NEVER an exact `role === 'admin'` (it hard-blocks a real admin; ladder creator<builder<domain_admin<admin), never invent app roles, and make client checks ADVISORY (hide/disable, not a blocking error — the OS data layer enforces). Next: verify_software.", write: false },
  // ---- Test & Publish ----
  { name: 'verify_software', description: "STAGE 5 · TEST & PUBLISH (test half). Verify a built unit against its Design spec across the FIVE dimensions (Functionality · User Experience · Code Structure · Security · Documentation). Returns the governed TEST directive + spec + committed files to verify against (read-only). Report PASS/FAIL per dimension; pass any shortfalls as `findings` (each { storyId, note, dimension }) and they are normalized into dimension-tagged REFINEMENTS via the SAME refinement model the UI uses — a missed-spec item is a rebuild, a requirement change routes to Design first. Next (if PASS): request_deploy.", write: false },
  { name: 'request_deploy', description: 'STAGE 5 · TEST & PUBLISH (publish half). Request a domain deploy → opens the Builder review gate (security scan + envelope + diff). Cannot self-approve a go-live.', write: true },
  { name: 'decide_deploy', description: 'STAGE 5 · TEST & PUBLISH. Approve/deny a deploy (Builder/Admin only — role-gated, requires a passing security scan).', write: true },
  { name: 'promote', description: 'STAGE 5 · TEST & PUBLISH. Promote the app one tier (role-gated, same as UI).', write: true },
  // ---- Declarative AppSpec authoring (the spec IS the app — no image build) ----
  {
    name: 'set_app_spec',
    description:
      "AUTHOR A DECLARATIVE APP (author = PUBLISH — this writes the LIVE spec and snapshots a version). Set the app's validated AppSpec — the spec IS the app, served SAME-ORIGIN by the trusted OS renderer under the viewer's session (NO image / CI / registry / pod). An AppSpec is `{ version: 2, name, description, theme?, functions?, tabs: [] }`. `theme` is an app-wide `{ css }` (scoped under the app root; may not contain `<`/`>`). `functions` are governed query/expression DSL functions (aggregate or expression over granted data) a `kpi-overview` card can render by `functionId`. Each TAB renders EITHER a cookbook PATTERN (`{ kind: 'pattern', pattern, config }`) OR a sandboxed CUSTOM block (`{ kind: 'custom', html, css?, js?, data? }` — a null-origin iframe that can never act as the user). Implemented patterns — VIEW (read): " + IMPLEMENTED_PATTERN_LIST.view + "; INTERACTIVE (write via the governed `os.records` door + role gates, never arbitrary code): " + IMPLEMENTED_PATTERN_LIST.interactive + ". A data-backed pattern's `config.source.datasetId` MUST be a dataset GRANTED to the app (bind it first via Choose Context / `design_software` grants) and every referenced column (`columns[].field`, `keyField`, `statusField`, `dateField`, filter fields, …) MUST exist in that dataset's real schema — call `get_dataset` to discover the exact column names. VALIDATION runs author-time and is the gate: on any BLOCKING issue the tool returns `{ ok: false, issues: [{ path, reason, fix }] }` and PERSISTS NOTHING (each fix is machine-actionable — grant the source, restore the dataset, or use a real column). On success it persists the spec as the LIVE served surface (serveMode flips to 'spec') AND snapshots a version, and returns `{ ok: true, servedUrl: '/apps/<slug>', version, warnings }` — the app is live at servedUrl with no build latency. Role: owner or an owning-domain builder+ (same gate as design_software). Scaffold a whole app in one call with generate_app_spec first; read-modify-write with get_app_spec.",
    write: true,
  },
  {
    name: 'generate_app_spec',
    description:
      "SCAFFOLD A DECLARATIVE APP from its DESIGN. Reads the app's epics + user stories + per-story spec (features/NFRs/rules) and its GRANTED context (datasets with their REAL columns, metrics, agents), then asks the OS reasoning model to compose a complete, validated AppSpec whose tabs are cookbook patterns wired ONLY to granted ids + real columns. Returns `{ ok: true, spec }` (a validated AppSpec — NOT yet persisted; review it with the returned `spec` / get_app_spec, then author it live with set_app_spec) or `{ ok: false, error, issues? }` when the design is empty (grant/design first) or the model can't produce a valid spec. This is the AI-coder scaffold: one call to go from a designed app to a valid spec, without hand-writing tabs. Role: owner or an owning-domain builder+ (same gate as set_app_spec). Next: set_app_spec to publish it live.",
    write: false,
  },
  {
    name: 'get_app_spec',
    description:
      "READ A DECLARATIVE APP for read-modify-write. Returns `{ spec, serveMode, describe }` for one app you can see (same visibility gate as `get_software`): `spec` is the current validated AppSpec or null (null ⇒ not a spec app / no spec yet); `serveMode` is 'spec' | 'image' | 'runtime'; `describe` is the plain-language legibility summary (`describeApp` — name, themed flag, and each tab's kind / what-it-does / data source / role gate). Use it to fetch the live spec, edit tabs/patterns/theme/functions, and write it back with `set_app_spec`. Governance: read-only, unseeable id → not_found.",
    write: false,
  },
  // ---- Publish helpers / lifecycle ----
  { name: 'start_preview', description: 'Start the private sandbox preview (no review).', write: true },
  { name: 'use_connection', description: 'Consume a granted Connection (no raw creds).', write: true },
  { name: 'use_data', description: 'Consume a granted Data product (no raw creds).', write: true },
  { name: 'use_knowledge', description: 'Consume granted Knowledge (no raw creds).', write: true },
  { name: 'use_as_data', description: 'Snapshot app data into a Bronze dataset.', write: true },
  { name: 'archive', description: 'Archive the app (disable + retain data).', write: true },
  { name: 'delete', description: 'Delete the app (lineage-aware; blocked if depended on).', write: true },
  // ---- Developer mode (the escape hatch — NOT the default path) ----
  { name: 'commit', description: 'DEVELOPER MODE — writes files DIRECTLY to the app folders, BYPASSING the staged Design→Build→Test governance and the design-before-build gate. Role-gated to builder/admin; a Creator cannot use it. Use the governed stage tools (design_software → build_software → verify_software) for the normal flow; reach for commit only as a deliberate exception.', write: true },
];

export type PlatformMcpArgs = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce a `surface` arg into a valid declaration, or undefined (→ auto-detect). */
function asSurface(v: unknown): SurfaceDeclaration | undefined {
  const s = str(v).trim().toLowerCase();
  return s === 'ui' || s === 'api' || s === 'both' ? s : undefined;
}

/**
 * Read the committed files a Build/Test directive grounds the agent in — the SAME
 * view-gated tree the UI + `read_app_files` MCP tool read. Bounded (`maxFiles`) and
 * per-file truncated so a large repo cannot blow the response; honestly labelled with
 * the tree's `mode` (live repo vs the committed snapshot). Best-effort: an unreachable
 * repo yields an empty list rather than failing the whole stage tool.
 */
async function committedFiles(
  appId: string,
  user: CurrentUser,
  maxFiles = 40,
): Promise<{ mode: string; files: { path: string; content: string; truncated?: boolean }[] }> {
  try {
    const tree = await listAppFilesForViewer(appId, user);
    const out: { path: string; content: string; truncated?: boolean }[] = [];
    for (const path of tree.files.slice(0, maxFiles)) {
      try {
        const f = await readAppFileForViewer(appId, user, path);
        const truncated = f.content.length > 24_000;
        out.push({ path: f.path, content: truncated ? f.content.slice(0, 24_000) : f.content, ...(truncated ? { truncated } : {}) });
      } catch {
        /* binary / oversized blob — skip it */
      }
    }
    return { mode: tree.mode, files: out };
  } catch {
    return { mode: 'offline-mock', files: [] };
  }
}

/**
 * The single governed entry point for every Platform MCP call. It runs under the
 * caller's delegated identity and delegates to the same library functions the UI
 * uses — so the governance invariant holds by construction, not by duplication.
 */
export async function callPlatformMcp(
  user: CurrentUser,
  tool: string,
  args: PlatformMcpArgs = {},
): Promise<unknown> {
  const appId = str(args.appId);
  let result: unknown;

  switch (tool) {
    case 'create_software':
      result = await createApp(user, {
        name: str(args.name),
        description: str(args.description),
        // Default to the Sovereign standard app — the same default the UI uses.
        template: (str(args.template) || 'sovereign-app') as AppTemplateKey,
        domain: str(args.domain) || undefined,
        // Intent wins over auto-detect: a declared surface never regresses to API.
        surface: asSurface(args.surface),
        purpose: str(args.purpose) || undefined,
        // DECLARATIVE-FIRST (0.6.136): default to 'spec' (same-origin, no image pipeline).
        // Coded is off by default and platform-admin-gated, so an explicit `kind:'code'`
        // still requests the coded path (createApp fails-closed 403 when it is disabled).
        kind: str(args.kind) === 'code' ? 'code' : 'spec',
      });
      break;

    case 'design_software': {
      // STAGE 2 · DESIGN — the SAME governed write the UI Design stage calls
      // (patchAppDesign). Its own fail-closed edit-scope re-gates owner/domain-admin/
      // admin; an explicit view-gate first yields a typed not_found on an invisible id.
      await getAppForUser(appId, user);
      result = await patchAppDesign(appId, user, {
        purpose: args.purpose !== undefined ? str(args.purpose) : undefined,
        epics: args.epics !== undefined ? (args.epics as AppEpic[]) : undefined,
        grants: args.grants !== undefined ? normalizeContextGrants(args.grants) : undefined,
      });
      break;
    }

    case 'build_software': {
      // STAGE 3 · BUILD — view-gate, resolve the target, ENFORCE the design-before-build
      // gate, then return the governed BUILD directive (reasoning tier) + committed files
      // + honest built-vs-pending. The agent authors the code and calls `commit`.
      const app = await getAppForUser(appId, user);
      const target = asBuildTarget(args.target);
      const resolved = resolveTarget(app, target);
      if (resolved.notFound) throw withStatus(new Error(`No epic/story matches that target on ${app.name}.`), 404);
      const gate = buildGate(app, target);
      if (!gate.ok) throw withStatus(new Error(gate.reason), 409);
      const buildGrants = await resolveGrantedContext(app.grants, user);
      result = {
        stage: 'build',
        appId: app.id,
        target,
        tier: 'standard',
        gate: 'passed',
        directive: stageDirective(app, target, 'build', buildGrants),
        progress: targetProgress(app, target),
        code: await committedFiles(appId, user),
        next: "Author the code per the directive, then `commit` — the story is marked built by the SUCCESSFUL commit itself (files landed), not by a status you set. Then verify_software.",
      };
      break;
    }

    case 'verify_software': {
      // STAGE 4 · TEST — view-gate, then return the governed 5-dimension TEST directive +
      // the committed code to verify against (read-only). Optional agent-supplied findings
      // are normalized into dimension-tagged refinements via the SAME refinement model the UI uses.
      const app = await getAppForUser(appId, user);
      const target = asBuildTarget(args.target);
      const resolved = resolveTarget(app, target);
      if (resolved.notFound) throw withStatus(new Error(`No epic/story matches that target on ${app.name}.`), 404);
      const validStory = (storyId: string): { epicId: string } | null => {
        for (const e of app.epics ?? []) if (e.stories.some((s) => s.id === storyId)) return { epicId: e.id };
        return null;
      };
      const refinements: Improvement[] = Array.isArray(args.findings)
        ? (args.findings as Record<string, unknown>[])
            .map((f) => normalizeImprovement(f, validStory))
            .filter((r): r is Improvement => r !== null)
        : [];
      const testGrants = await resolveGrantedContext(app.grants, user);
      result = {
        stage: 'test',
        appId: app.id,
        target,
        tier: 'reasoning',
        directive: stageDirective(app, target, 'test', testGrants),
        code: await committedFiles(appId, user),
        refinements,
        refinementsNote:
          'Report PASS/FAIL per dimension. Each shortfall → one refinement { storyId, note, dimension }: a missed-spec item is a rebuild (buildable now); a requirement change is kind:"design" and must go to design_software first.',
      };
      break;
    }

    case 'set_app_spec': {
      // AUTHOR a declarative app. Delegates to the SAME governed server fn the UI/route
      // uses (setAppSpec), run AS the caller — its own owner/domain-builder gate + the
      // author-time validateAppSpec gate apply. On a BLOCKING issue nothing is persisted;
      // we surface the typed { path, reason, fix } issues so the author can self-correct.
      const { app, issues, warnings, version } = await setAppSpec(appId, args.spec, user);
      result =
        issues.length > 0
          ? { ok: false, issues, warnings }
          : { ok: true, servedUrl: `/apps/${app.slug}`, version, warnings };
      break;
    }

    case 'generate_app_spec': {
      // SCAFFOLD a declarative app from its design. Delegates to the SAME governed server fn the
      // ✨ Generate-my-app route calls (generateAppSpecForApp) — owner-or-in-domain-builder gate +
      // the reasoning model + the structural/semantic validation loop. Returns a validated (or
      // failed) candidate; it PERSISTS NOTHING (the author reviews then set_app_spec publishes it).
      result = await generateAppSpecForApp(user, appId);
      break;
    }

    case 'get_app_spec': {
      // READ a declarative app for read-modify-write. Same visibility gate as get_software.
      const app = await getAppForUser(appId, user);
      result = {
        appId: app.id,
        slug: app.slug,
        serveMode: serveModeOf(app),
        spec: app.spec ?? null,
        // Legibility summary — only meaningful when a spec is present.
        describe: app.spec ? describeApp(app.spec) : null,
      };
      break;
    }

    case 'commit': {
      // FAIL-CLOSED (os-ui 0.6.133): `commit` is the CODED-path raw file write — it only
      // makes sense for a coded (image) app. When the platform admin has coded apps OFF
      // (the default), refuse it with a clear message; a Declarative app is authored with
      // set_app_spec, not commit. This mirrors the createApp create-gate so neither UI nor
      // API nor MCP can build a coded app when off.
      if (!codedAppsEnabled()) {
        throw withStatus(
          new Error('Coded apps are disabled by the platform administrator. Author a Declarative (no-code) app with set_app_spec instead of committing raw code.'),
          403,
        );
      }
      // DEVELOPER MODE — a raw direct file write that BYPASSES the staged Design→Build→
      // Test governance and the design-before-build gate. Role-gated to builder/admin so a
      // Creator cannot bypass the governed stages; the governed path is design/build/verify.
      if (!roleAtLeast(user.role, 'builder')) {
        throw withStatus(
          new Error('commit is Developer mode (direct file write) — available to Builders/Administrators. Use design_software → build_software → verify_software for the governed flow.'),
          403,
        );
      }
      // Validate REQUIRED args at the tool layer — a corrective, machine-actionable 400
      // the agent loop can self-correct on, NEVER the confusing `not_found: App not found`
      // that an empty `appId` produced live (the build agent's `commit({})` empty-args call).
      // In the per-app Build run the appId is bound server-side, so a well-behaved agent
      // never trips this; the raw Platform MCP path still needs the id + at least one file.
      if (!appId) {
        throw withStatus(
          new Error('commit needs an `appId` (from list_software). In the per-app Build chat the appId is bound automatically — just pass the files.'),
          400,
        );
      }
      const files = Array.isArray(args.files) ? (args.files as { path: string; content: string }[]) : [];
      if (files.length === 0) {
        throw withStatus(
          new Error(
            'commit needs at least one file: an empty commit writes nothing. Do NOT write the code as prose in your reply — the server only receives what you pass in `files`. Author the code, then call commit with the EXACT shape: ' +
              'commit({ files: [{ path: "src/epics/<epic>/<story>/Page.tsx", content: "<the full file source>" }] }). ' +
              'If you stalled because a story needs DATA that no granted dataset provides, do NOT invent a dataset here — that data need must be RESOLVED IN DESIGN first (bind an existing dataset, or create one — empty or with sample data), then rebuild. ' +
              'Otherwise retry now with the files array populated.',
          ),
          400,
        );
      }
      const authored = await authorThroughFrontDoor('platform-mcp', {
        name: str(args.name),
        owner: user.id,
        description: str(args.description),
        message: str(args.message) || 'commit via Platform MCP (developer mode)',
        files,
      });
      result = await commitToApp(appId, user, authored.files, authored.message);
      break;
    }

    case 'start_preview':
      result = await startPreview(appId, user);
      break;

    case 'request_deploy':
      // Identical review gate as the UI — the MCP CANNOT self-approve a go-live.
      result = await requestDeploy(appId, user);
      break;

    case 'decide_deploy':
      // Role-gated inside decideDeploy: a non-Builder caller gets 403, same as UI.
      result = await decideDeploy(
        str(args.cardId),
        user,
        str(args.decision) === 'approve' ? 'approve' : 'deny',
        str(args.note) || undefined,
      );
      break;

    case 'use_connection':
    case 'use_data':
    case 'use_knowledge': {
      const kind: ConsumedResource['kind'] =
        tool === 'use_connection' ? 'connection' : tool === 'use_data' ? 'data' : 'knowledge';
      result = await consumeResource(appId, user, {
        kind,
        ref: str(args.ref),
        label: str(args.label) || str(args.ref),
        scope: str(args.scope) === 'write-bounded' ? 'write-bounded' : 'read',
      });
      break;
    }

    case 'use_as_data':
      result = await useAsData(appId, user);
      break;

    case 'promote':
      // Route the flip through the ONE effect seam (never promoteApp directly).
      // Role-gated inside the seam's applier (promoteApp): a Creator/non-Admin at
      // the wrong rung gets a typed 403, exactly as in the UI.
      result = await promoteThroughSeam('app', appId, user);
      break;

    case 'archive':
      result = await archiveApp(appId, user);
      break;

    case 'delete':
      result = await deleteApp(appId, user);
      break;

    default:
      throw withStatus(new Error(`Unknown Platform MCP tool: ${tool}`), 400);
  }

  // Every call is audited with the caller's delegated identity (transparency gate).
  void trace({
    principal: PLATFORM_MCP_PRINCIPAL,
    tool: 'generate',
    input: { mcpTool: tool, by: user.id, role: user.role, appId: appId || undefined },
    output: { ok: true },
    decision: 'allow',
  });
  return result;
}

/**
 * A self-check used by the invariant test + the platform: confirm the MCP exposes
 * exactly the same governed operations the UI does and nothing more (no admin/
 * service back door). Returns the tool names so a test can diff against the UI.
 */
export function platformMcpToolNames(): string[] {
  return PLATFORM_MCP_TOOLS.map((t) => t.name).sort();
}

