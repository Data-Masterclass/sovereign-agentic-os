/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream C2 MCP tools (releases, Dev/Prod deploy, previews, logs, rollback, needs-rebuild)
 * USER STORY: As an MCP client I want every App Builder action of workstream C2 to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - EXTENSION POINT created empty by W0; owned by workstream C2 (plan: `list_app_runs`, `get_app_run`, `list_app_releases`, `get_app_logs`, `rollback_app`, `run_app_migration`; handlers for `start_preview`, `request_deploy`, `decide_deploy`, `get_software_status`).
 *   - `c2Tools`: NEW tools. index.ts wraps each with the App Builder guard (flag off ⇒ `app_builder_disabled`).
 *   - `c2Handlers`: keyed by an EXISTING Platform MCP tool name; called for `templateVersion: 2` apps only, with the
 *     flag on (index.ts `routeToAppBuilder`).
 */
import type { McpTool } from '@core/mcp/server';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';

export const c2Tools: McpTool[] = [];

export const c2Handlers: Record<string, AppBuilderHandler> = {};
