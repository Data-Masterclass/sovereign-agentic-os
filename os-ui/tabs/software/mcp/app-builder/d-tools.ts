/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream D MCP tools (Postgres per app, env and secrets, migrations)
 * USER STORY: As an MCP client I want every App Builder action of workstream D to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - EXTENSION POINT created empty by W0; owned by workstream D (plan: `list_app_env`, `set_app_env`, `unset_app_env`, `get_app_database`).
 *   - `dTools`: NEW tools. index.ts wraps each with the App Builder guard (flag off ⇒ `app_builder_disabled`).
 *   - `dHandlers`: keyed by an EXISTING Platform MCP tool name; called for `templateVersion: 2` apps only, with the
 *     flag on (index.ts `routeToAppBuilder`).
 */
import type { McpTool } from '@core/mcp/server';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';

export const dTools: McpTool[] = [];

export const dHandlers: Record<string, AppBuilderHandler> = {};
