/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    The account menu — the three personal surfaces that left the Platform menu
 * USER STORY: As a signed-in user I want My Settings, My MCP access and About / Licenses in
 *             one place under my own name in the sidebar, so I stop hunting for my own
 *             settings inside a menu of things only a tenant admin may touch.
 * ARCHITECTURE:
 *   - Data only; no React, no I/O — the same shape `tabs/admin/lib/sections.ts` uses, so the
 *     contract is testable without rendering. `Sidebar.tsx` imports it, filters it with
 *     `roleAtLeast` from `@core/kernel/session`, and re-exports `ACCOUNT_ITEMS` so the
 *     sidebar stays the single named owner of the account menu.
 *   - It lives beside Sidebar.tsx rather than inside it because the test runner strips types
 *     but not JSX: a `.tsx` module cannot be imported under `node --test` (and Sidebar also
 *     pulls in next/navigation and an .svg, neither loadable there).
 *   - Routes are unchanged from when these were Platform sections (/settings, /mcp, /about),
 *     and so are their `minRole`s — moving a surface must not widen access. `minRole` is
 *     advisory for rendering only; each page re-checks the role server-side.
 */
import type { Role } from '@core/kernel/session';

export type AccountItem = {
  /** Stable id — matches the id the section carried in the Platform menu. */
  id: string;
  label: string;
  href: string;
  /** Single-glyph marker, as in `core/kernel/tabs.ts`. */
  icon: string;
  minRole: Role;
};

/** The personal surfaces, in menu order. */
export const ACCOUNT_ITEMS: readonly AccountItem[] = [
  { id: 'my-settings', label: 'My Settings', href: '/settings', icon: '⚙', minRole: 'builder' },
  { id: 'my-mcp', label: 'My MCP access', href: '/mcp', icon: '⚿', minRole: 'builder' },
  { id: 'licenses', label: 'About / Licenses', href: '/about', icon: 'ⓘ', minRole: 'creator' },
] as const;
