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
  listAppFilesForViewer,
  readAppFileForViewer,
  withStatus,
  type AppEpic,
  type AppTemplateKey,
} from '@/lib/software/apps';
import { normalizeContextGrants } from '@/lib/core/context-grants';
import { promoteThroughSeam } from '@/lib/governance/ladder';
import { trace } from '@/lib/infra/agent-governed';
import { startPreview, requestDeploy, decideDeploy } from './review.ts';
import { archiveApp, deleteApp, useAsData, consumeResource } from './lifecycle.ts';
import { authorThroughFrontDoor, commitToApp } from './server.ts';
import type { ConsumedResource, SurfaceDeclaration } from './model.ts';
import { asBuildTarget, buildGate, stageDirective, targetProgress, resolveTarget } from './mcp-stages.ts';
import { normalizeImprovement, type Improvement } from './improvements.ts';

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
 * The MCP tool surface — parity with the UI's five governed stages:
 *   Define  → create_software
 *   Design  → design_software  (author the epic/story/spec tree)
 *   Build   → build_software   (unit-scoped, design-before-build gated, standard tier)
 *   Test    → verify_software  (5-dimension verification → dimension-tagged refinements)
 *   Publish → request_deploy / decide_deploy / promote (governed, role-gated)
 *
 * The STAGED tools are the advertised default path — an external agent walks the
 * identical governed flow to the UI. `commit` remains as a DEVELOPER-MODE escape hatch
 * (raw file write, role-gated to builder/admin) for the deliberate exception.
 */
export const PLATFORM_MCP_TOOLS: { name: string; description: string; write: boolean }[] = [
  // ---- Define ----
  { name: 'create_software', description: "STAGE 1 · DEFINE. Create a new governed app from a template (default `sovereign-app` — the Sovereign standard app: AppShell chrome, OS-delegated identity, domain-scoped data helpers, an admin section and the MCP top-bar link already wired; epics then add business features). Other templates: 'website', 'api-service', 'empty' (and legacy 'vite-os','nextjs-supabase','service','script','dashboard'). Optionally DECLARE its surface (surface: 'ui' | 'api' | 'both') — declaring wins over auto-detection, so a UI app is never mislabelled as API. Optionally set `purpose` (the app's stated intent, ≤2000 chars). Next: design_software.", write: true },
  // ---- Design ----
  { name: 'design_software', description: "STAGE 2 · DESIGN. Author or update the app's specification tree — `purpose`, `epics` (each with user stories and per-story `spec` of features / non-functional requirements / rules), and governed context `grants`. This is the SAME governed write the UI Design stage uses (patchAppDesign): owner / owning-domain admin / platform admin only. A story must have a spec here before build_software will build it (the design-before-build gate). Next: build_software.", write: true },
  // ---- Build ----
  { name: 'build_software', description: "STAGE 3 · BUILD. Build a SPECIFIC unit — the whole app, one `epic`, or one `story` (pass `target`) — from its FINALIZED Design spec. Enforces the design-before-build gate (refuses stories with no spec, naming them), pins the STANDARD model tier, and returns the governed BUILD directive + Define context + the target's spec + the code-structure convention (write each story under epics/<epic>/<story>/, app/ stays thin) + the current committed files and honest built-vs-pending progress. You then author the code and call `commit`, then mark built stories done via design_software (status:'done'). Next: verify_software.", write: false },
  // ---- Test ----
  { name: 'verify_software', description: "STAGE 4 · TEST. Verify a built unit against its Design spec across the FIVE dimensions (Functionality · User Experience · Code Structure · Security · Documentation). Returns the governed TEST directive + spec + committed files to verify against (read-only). Report PASS/FAIL per dimension; pass any shortfalls as `findings` (each { storyId, note, dimension }) and they are normalized into dimension-tagged REFINEMENTS via the SAME refinement model the UI uses — a missed-spec item is a rebuild, a requirement change routes to Design first. Next (if PASS): request_deploy.", write: false },
  // ---- Publish ----
  { name: 'request_deploy', description: 'STAGE 5 · PUBLISH. Request a domain deploy → opens the Builder review gate (security scan + envelope + diff). Cannot self-approve a go-live.', write: true },
  { name: 'decide_deploy', description: 'STAGE 5 · PUBLISH. Approve/deny a deploy (Builder/Admin only — role-gated, requires a passing security scan).', write: true },
  { name: 'promote', description: 'STAGE 5 · PUBLISH. Promote the app one tier (role-gated, same as UI).', write: true },
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
      // gate, then return the governed BUILD directive (standard tier) + committed files
      // + honest built-vs-pending. The agent authors the code and calls `commit`.
      const app = await getAppForUser(appId, user);
      const target = asBuildTarget(args.target);
      const resolved = resolveTarget(app, target);
      if (resolved.notFound) throw withStatus(new Error(`No epic/story matches that target on ${app.name}.`), 404);
      const gate = buildGate(app, target);
      if (!gate.ok) throw withStatus(new Error(gate.reason), 409);
      result = {
        stage: 'build',
        appId: app.id,
        target,
        tier: 'standard',
        gate: 'passed',
        directive: stageDirective(app, target, 'build'),
        progress: targetProgress(app, target),
        code: await committedFiles(appId, user),
        next: "Author the code per the directive, then `commit`; mark completed stories done with design_software (set the story's status to 'done'). Then verify_software.",
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
      result = {
        stage: 'test',
        appId: app.id,
        target,
        tier: 'reasoning',
        directive: stageDirective(app, target, 'test'),
        code: await committedFiles(appId, user),
        refinements,
        refinementsNote:
          'Report PASS/FAIL per dimension. Each shortfall → one refinement { storyId, note, dimension }: a missed-spec item is a rebuild (buildable now); a requirement change is kind:"design" and must go to design_software first.',
      };
      break;
    }

    case 'commit': {
      // DEVELOPER MODE — a raw direct file write that BYPASSES the staged Design→Build→
      // Test governance and the design-before-build gate. Role-gated to builder/admin so a
      // Creator cannot bypass the governed stages; the governed path is design/build/verify.
      if (!roleAtLeast(user.role, 'builder')) {
        throw withStatus(
          new Error('commit is Developer mode (direct file write) — available to Builders/Administrators. Use design_software → build_software → verify_software for the governed flow.'),
          403,
        );
      }
      const authored = await authorThroughFrontDoor('platform-mcp', {
        name: str(args.name),
        owner: user.id,
        description: str(args.description),
        message: str(args.message) || 'commit via Platform MCP (developer mode)',
        files: Array.isArray(args.files) ? (args.files as { path: string; content: string }[]) : [],
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

