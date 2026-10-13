/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AppSpec navigation selection — the PURE, DOM-free helpers the `<AppSpecRenderer>` shares
 * with node:test. They decide WHICH tabs a viewer may see and WHICH one is active, using the
 * SAME `roleAtLeast` ladder every OS gate uses (advisory hide; real enforcement stays at the
 * data layer). Kept out of the JSX so the gating logic is unit-tested once, thoroughly,
 * without a React renderer.
 */
import { roleAtLeast, type Role } from '@/lib/core/session.ts';
import type { AppSpec, Tab } from './schema.ts';

/**
 * The tabs a viewer of `role` may see: a tab with no `roleGate` is always visible; a gated tab
 * shows only when `roleAtLeast(role, gate)`. A NULL role (identity still loading / signed-out)
 * can reach ONLY ungated tabs — gated ones stay hidden until we know the role, never crash.
 * Order is preserved (the author's nav order).
 */
export function visibleTabs(spec: AppSpec, role: Role | null): Tab[] {
  return spec.tabs.filter((t) => {
    if (!t.roleGate) return true;
    if (role === null) return false;
    return roleAtLeast(role, t.roleGate);
  });
}

/**
 * The tab to render for `activeId`, from the VISIBLE set (so a viewer can never land on a tab
 * their role can't reach). Falls back to the first visible tab when `activeId` is
 * missing/unknown, and to `undefined` only when the viewer has no visible tab at all (the
 * renderer then shows an honest empty state instead of crashing).
 */
export function pickTab(spec: AppSpec, activeId: string | null, role: Role | null): Tab | undefined {
  const visible = visibleTabs(spec, role);
  if (visible.length === 0) return undefined;
  if (activeId) {
    const found = visible.find((t) => t.id === activeId);
    if (found) return found;
  }
  return visible[0];
}
