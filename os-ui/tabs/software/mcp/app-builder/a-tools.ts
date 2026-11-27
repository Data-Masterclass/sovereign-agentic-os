/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream A MCP tools (living spec: stories files, history, Stories view)
 * USER STORY: As an MCP client I want every App Builder action of workstream A to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - EXTENSION POINT created empty by W0; owned by workstream A (plan: `get_stories`, `get_story_history`; handler for `design_software` (writes story files)).
 *   - `aTools`: NEW tools. index.ts wraps each with the App Builder guard (flag off ⇒ `app_builder_disabled`).
 *   - `aHandlers`: keyed by an EXISTING Platform MCP tool name; called for `templateVersion: 2` apps only, with the
 *     flag on (index.ts `routeToAppBuilder`).
 */
import type { McpTool } from '@core/mcp/server';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';

export const aTools: McpTool[] = [];

export const aHandlers: Record<string, AppBuilderHandler> = {};
