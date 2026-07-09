/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { ALL_MCP_TOOLS, roleCanUse, type ToolTab } from '@/lib/mcp/server';
import { ALL_WRITE_TOOLS } from '@/lib/mcp/write-tools';
import type { Role } from '@/lib/core/session';

/** Write-tool names — these are state-modifying calls that may be held by Governance. */
const WRITE_NAMES = new Set(ALL_WRITE_TOOLS.map((t) => t.name));

export type CatalogEntry = {
  name: string;
  tab: ToolTab;
  minRole: Role;
  description: string;
  /**
   * True when the tool is a write operation that the Governance queue may hold for
   * human approval when called by an agent (i.e. it is in ALL_WRITE_TOOLS). The
   * `grantedToolExecutor` enforces this at runtime; this field lets the UI surface
   * a "needs approval" badge so the system author can set expectations.
   */
  requires_approval: boolean;
};

/**
 * The tools a user at `role` may grant to an agent system — scoped by role floor
 * so a creator can never grant a builder-floor tool (e.g. `approve_promotion`).
 * This is the same role filter the MCP server applies at `tools/list` time; it is
 * also the invariant that prevents privilege escalation via agent grants.
 */
export function buildCatalog(role: Role): CatalogEntry[] {
  return ALL_MCP_TOOLS.filter((t) => roleCanUse(role, t.minRole)).map((t) => ({
    name: t.name,
    tab: t.tab,
    minRole: t.minRole,
    description: t.description,
    requires_approval: WRITE_NAMES.has(t.name),
  }));
}

/**
 * The complete tool catalog with no role filtering — every tool the OS exposes
 * over MCP, including builder/admin-floor tools. Used by the MCP reference page
 * which is a read-only teaching surface (tool execution remains governed at
 * call time; listing the catalog is not a privilege escalation).
 */
export function buildFullCatalog(): CatalogEntry[] {
  return ALL_MCP_TOOLS.map((t) => ({
    name: t.name,
    tab: t.tab,
    minRole: t.minRole,
    description: t.description,
    requires_approval: WRITE_NAMES.has(t.name),
  }));
}
