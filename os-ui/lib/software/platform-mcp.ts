/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import {
  createApp,
  getAppByIdInternal,
  promoteApp,
  withStatus,
  type AppTemplateKey,
} from '@/lib/apps';
import { trace } from '@/lib/agent-governed';
import { startPreview, requestDeploy, decideDeploy } from './review.ts';
import { archiveApp, deleteApp, useAsData, consumeResource } from './lifecycle.ts';
import { authorThroughFrontDoor, commitToApp } from './server.ts';
import type { ConsumedResource } from './model.ts';

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

/** The MCP tool surface — parity with the UI's create→build→preview→deploy flow. */
export const PLATFORM_MCP_TOOLS: { name: string; description: string; write: boolean }[] = [
  { name: 'create_software', description: 'Create a new governed app from a template.', write: true },
  { name: 'commit', description: 'Commit files + metadata to an app (re-parsed on every commit).', write: true },
  { name: 'start_preview', description: 'Start the private sandbox preview (no review).', write: true },
  { name: 'request_deploy', description: 'Request a domain deploy → opens the Builder review gate.', write: true },
  { name: 'decide_deploy', description: 'Approve/deny a deploy (Builder/Admin only — role-gated).', write: true },
  { name: 'use_connection', description: 'Consume a granted Connection (no raw creds).', write: true },
  { name: 'use_data', description: 'Consume a granted Data product (no raw creds).', write: true },
  { name: 'use_knowledge', description: 'Consume granted Knowledge (no raw creds).', write: true },
  { name: 'use_as_data', description: 'Snapshot app data into a Bronze dataset.', write: true },
  { name: 'promote', description: 'Promote the app one tier (role-gated, same as UI).', write: true },
  { name: 'archive', description: 'Archive the app (disable + retain data).', write: true },
  { name: 'delete', description: 'Delete the app (lineage-aware; blocked if depended on).', write: true },
];

export type PlatformMcpArgs = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
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
        template: (str(args.template) || 'nextjs-supabase') as AppTemplateKey,
        domain: str(args.domain) || undefined,
      });
      break;

    case 'commit': {
      const authored = await authorThroughFrontDoor('platform-mcp', {
        name: str(args.name),
        owner: user.id,
        description: str(args.description),
        message: str(args.message) || 'commit via Platform MCP',
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
      // Role-gated inside promoteApp: a Creator gets 403, exactly as in the UI.
      result = await promoteApp(appId, user);
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

/** Touch an app so a caller can confirm visibility under their own identity. */
export async function mcpGetApp(user: CurrentUser, appId: string) {
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);
  // Same visibility rule as the UI: only the owner's own / their domain's / shared.
  const visible =
    (app.visibility === 'Personal' && app.owner === user.id) ||
    (app.visibility === 'Shared' && user.domains.includes(app.domain)) ||
    app.visibility === 'Certified';
  if (!visible) throw withStatus(new Error('App not found'), 404);
  return app;
}
