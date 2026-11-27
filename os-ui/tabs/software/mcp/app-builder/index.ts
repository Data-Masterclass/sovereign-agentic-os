/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - one dispatch for every workstream's MCP tools and v2 handlers
 * USER STORY: As the owner I want every App Builder MCP tool to answer `app_builder_disabled` while the switch is off,
 *             and existing golden-path tools to behave exactly as today for every app that is not a v2 app.
 * ARCHITECTURE:
 *   - Collects `a/b/c2/d-tools.ts`. W0 owns this file; workstreams only fill their own file.
 *   - `appBuilderTools`: every new tool, its `call` wrapped so the guard runs FIRST (no argument parsing, no lookup)
 *     and throws the typed refusal while the flag is off. Spread into `softwareWriteTools`.
 *   - `routeToAppBuilder(tool, user, args)`: called at the top of `callPlatformMcp`. Returns null (= today's code path)
 *     when the flag is off, when no workstream handles `tool`, when there is no `appId`, or when the app is not
 *     `templateVersion: 2`. Only then is the app read (with the caller's visibility), so with the flag off this does
 *     no work at all.
 *   - A tool name or handler registered twice is a load-time error, so two workstreams cannot shadow each other.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool } from '@core/mcp/server';
import { appBuilderEnabled, assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import { getAppForUser } from '@tabs/software/lib/apps';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';
import { aHandlers, aTools } from '@tabs/software/mcp/app-builder/a-tools';
import { bHandlers, bTools } from '@tabs/software/mcp/app-builder/b-tools';
import { c2Handlers, c2Tools } from '@tabs/software/mcp/app-builder/c2-tools';
import { dHandlers, dTools } from '@tabs/software/mcp/app-builder/d-tools';

export type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';

/** Wrap a tool so the App Builder guard runs before anything else. */
export function guardAppBuilderTool(t: McpTool): McpTool {
  const call = t.call;
  return {
    ...t,
    call: async (user, args) => {
      assertAppBuilderEnabled();
      return call(user, args);
    },
  };
}

/** Merge per-workstream maps or lists, refusing a duplicate name. */
export function mergeUnique<T>(label: string, parts: Record<string, Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  const owner: Record<string, string> = {};
  for (const [ws, map] of Object.entries(parts)) {
    for (const [name, v] of Object.entries(map)) {
      if (name in out) throw new Error(`App Builder ${label} '${name}' is registered by both ${owner[name]} and ${ws}`);
      out[name] = v;
      owner[name] = ws;
    }
  }
  return out;
}

const byName = (tools: McpTool[]) => Object.fromEntries(tools.map((t) => [t.name, t]));

export const appBuilderTools: McpTool[] = Object.values(
  mergeUnique('tool', { a: byName(aTools), b: byName(bTools), c2: byName(c2Tools), d: byName(dTools) }),
).map(guardAppBuilderTool);

/**
 * The App Builder tools that only READ. They never land in the write barrel (`softwareWriteTools` → `ALL_WRITE_TOOLS`,
 * which the hold gate treats as writes); the `software-write` bundle (register-experimental.ts) registers them next to
 * the tab's other reads. Every name here must also be a reviewed read in the kernel's READ_TOOLS list (core/mcp, tool classes)
 * (app-builder-w0.test.ts pins it). Anything not listed stays a write: an unlisted tool is held, never waved through.
 * Listed explicitly rather than imported: production code may not consult the confirm classes yet (the kernel's groundwork test).
 */
export const APP_BUILDER_READ_TOOL_NAMES: ReadonlySet<string> = new Set(['get_stories', 'get_story_history']);
const READS = APP_BUILDER_READ_TOOL_NAMES;
export const appBuilderReadTools: McpTool[] = appBuilderTools.filter((t) => READS.has(t.name));
export const appBuilderWriteTools: McpTool[] = appBuilderTools.filter((t) => !READS.has(t.name));

export const appBuilderHandlers: Record<string, AppBuilderHandler> = mergeUnique('handler', { a: aHandlers, b: bHandlers, c2: c2Handlers, d: dHandlers });

/**
 * The v2 route for an EXISTING Platform MCP tool: `{ result }` when a workstream handled it, null to run today's code.
 * `handlers` is injectable for tests.
 */
export async function routeToAppBuilder(
  tool: string,
  user: CurrentUser,
  args: Record<string, unknown>,
  handlers: Record<string, AppBuilderHandler> = appBuilderHandlers,
): Promise<{ result: unknown } | null> {
  if (!appBuilderEnabled()) return null;
  const h = Object.prototype.hasOwnProperty.call(handlers, tool) ? handlers[tool] : undefined;
  const appId = typeof args.appId === 'string' ? args.appId : '';
  if (!h || !appId) return null;
  const app = await getAppForUser(appId, user);
  if (templateVersionOf(app) !== 2) return null;
  return { result: await h(user, args, app) };
}
