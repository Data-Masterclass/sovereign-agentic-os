/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - the shape of a workstream's MCP extension point
 * USER STORY: As a workstream author I want to add MCP tools, and the App Builder behaviour of existing golden-path
 *             tools, in my own file, without editing the shared tool lists.
 * ARCHITECTURE:
 *   - A workstream file (`a-tools.ts`, `b-tools.ts`, `c2-tools.ts`, `d-tools.ts`) exports a `McpTool[]` of NEW tools and
 *     a `Record<string, AppBuilderHandler>` keyed by the name of an EXISTING Platform MCP tool (`design_software`,
 *     `build_software`, `request_deploy`, …) whose behaviour changes for `templateVersion: 2` apps.
 *   - `index.ts` wraps every new tool with the App Builder guard and dispatches the handlers; no workstream touches it.
 */
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool } from '@core/mcp/server';
import type { App } from '@tabs/software/lib/apps';

/** Handles an EXISTING Platform MCP tool for a v2 app. `app` is already visibility-checked for `user`. */
export type AppBuilderHandler = (user: CurrentUser, args: Record<string, unknown>, app: App) => Promise<unknown>;

export type AppBuilderToolSet = { tools: McpTool[]; handlers: Record<string, AppBuilderHandler> };
