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
 *   - My Settings is `creator` since i18n wave 1 (owner decision 2026-11-26: EVERY user picks their language
 *     there). That widens nothing: the page was already reachable by URL for any signed-in user, and its
 *     deployment sections (tenant, namespace, versions, stack status) now render for builder+ only, re-checked
 *     server-side on the page.
 *   - Labels are catalog keys in the `shell` namespace (`labelKey`), translated by the Sidebar; `label` stays the
 *     English text for non-UI readers (tests, docs).
 */
import type { Role } from '@core/kernel/session';

export type AccountItem = {
  /** Stable id — matches the id the section carried in the Platform menu. */
  id: string;
  label: string;
  /** The `shell` catalog key the Sidebar renders (i18n). */
  labelKey: 'account.mySettings' | 'account.myMcp' | 'account.about';
  href: string;
  /** Single-glyph marker, as in `core/kernel/tabs.ts`. */
  icon: string;
  minRole: Role;
};

/** The personal surfaces, in menu order. */
export const ACCOUNT_ITEMS: readonly AccountItem[] = [
  { id: 'my-settings', label: 'My Settings', labelKey: 'account.mySettings', href: '/settings', icon: '⚙', minRole: 'creator' },
  { id: 'my-mcp', label: 'My MCP access', labelKey: 'account.myMcp', href: '/mcp', icon: '⚿', minRole: 'builder' },
  { id: 'licenses', label: 'About / Licenses', labelKey: 'account.about', href: '/about', icon: 'ⓘ', minRole: 'creator' },
] as const;

/** The sidebar's group headings (`core/kernel/tabs.ts`) → their `shell.nav.groups.*` key; null for an unknown one. */
export function shellHeadingKey(heading: string): 'context' | 'build' | 'manage' | null {
  const k = heading.trim().toLowerCase();
  return k === 'context' || k === 'build' || k === 'manage' ? k : null;
}
