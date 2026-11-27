/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream B MCP tools (classifier, build loop, lights, post-hoc proposals)
 * USER STORY: As an MCP client I want every App Builder action of workstream B to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - EXTENSION POINT created empty by W0; owned by workstream B (plan: `propose_requirement`, `decide_requirement`; handlers for `build_software`, `verify_software`).
 *   - `bTools`: NEW tools. index.ts wraps each with the App Builder guard (flag off ⇒ `app_builder_disabled`).
 *   - `bHandlers`: keyed by an EXISTING Platform MCP tool name; called for `templateVersion: 2` apps only, with the
 *     flag on (index.ts `routeToAppBuilder`).
 */
import type { McpTool } from '@core/mcp/server';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';

export const bTools: McpTool[] = [];

export const bHandlers: Record<string, AppBuilderHandler> = {};
