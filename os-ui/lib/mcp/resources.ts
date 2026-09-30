/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { TAB_FEATURES } from '@/lib/core/tabs';
import type { McpTab } from '@/lib/mcp/server';
import {
  RESOURCES as ALL_RESOURCES,
  RESOURCE_TEMPLATES as ALL_RESOURCE_TEMPLATES,
  type McpResource,
  type McpResourceTemplate,
} from '@/lib/experimental/mcp/resources';

/**
 * #28: real flag-gating for resources/templates — the underlying file's
 * unconditional RESOURCES/RESOURCE_TEMPLATES filtered by each item's own
 * `tab` field against TAB_FEATURES ('meta' is cross-cutting, always in).
 * bigbets' MCP tab is 'bigbets' but its UI feature key is 'big-bets'
 * (hyphenated) — same mapping as register-experimental.ts.
 */
const enabled = (tab: string): boolean =>
  tab === 'meta' || TAB_FEATURES.has(tab === 'bigbets' ? 'big-bets' : tab);

export const RESOURCES: McpResource[] = ALL_RESOURCES.filter((r) => enabled(r.tab));
export const RESOURCE_TEMPLATES: McpResourceTemplate[] = ALL_RESOURCE_TEMPLATES.filter((r) => enabled(r.tab));

export function resourcesForTab(tab: McpTab, all: McpResource[] = RESOURCES): McpResource[] {
  return all.filter((r) => r.tab === tab || r.tab === 'meta');
}
export function templatesForTab(tab: McpTab, all: McpResourceTemplate[] = RESOURCE_TEMPLATES): McpResourceTemplate[] {
  return all.filter((r) => r.tab === tab || r.tab === 'meta');
}

export type { McpResource, McpResourceTemplate };
