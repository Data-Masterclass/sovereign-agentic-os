/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * `summarizeSpecChange` — a DETERMINISTIC, plain-language diff of two AppSpecs, for the
 * Publish version snapshot's change summary (os-ui 0.6.135). No LLM: it reduces each spec via
 * `describeApp` and reports the tab-level + top-level deltas honestly ("Added Orders tab;
 * changed revenue KPI; removed Calendar"). Pure + total — a null `previous` (the FIRST publish)
 * yields an "Initial publish" summary, and identical specs yield "No changes".
 *
 * It compares the LEGIBILITY description (what each tab shows/does) rather than raw JSON so the
 * summary is about behaviour the user recognises, not incidental structural churn.
 */
import type { AppSpec } from './schema.ts';
import { describeApp, type TabDescription } from './describe.ts';

/** Short auto NAME for a published version — a monotonic release label. */
export function autoVersionName(release: number): string {
  return `v${release}`;
}

/** True when two tab descriptions are behaviourally identical (label + what + data + gate). */
function sameTab(a: TabDescription, b: TabDescription): boolean {
  return a.what === b.what && a.data === b.data && a.roleGate === b.roleGate && a.kind === b.kind;
}

/**
 * Diff two specs into a one-line plain summary. `previous === null` ⇒ the first publish.
 * The summary lists, in order: renamed app, changed description, added tabs, removed tabs,
 * changed tabs. Capped to a readable length; empty delta ⇒ "No changes".
 */
export function summarizeSpecChange(previous: AppSpec | null, next: AppSpec): string {
  const now = describeApp(next);
  if (!previous) {
    const n = now.tabs.length;
    return `Initial publish — ${n} ${n === 1 ? 'tab' : 'tabs'}`;
  }
  const before = describeApp(previous);
  const parts: string[] = [];

  if (before.name !== now.name) parts.push(`renamed to "${now.name}"`);
  if (before.description !== now.description) parts.push('changed description');

  const beforeByLabel = new Map(before.tabs.map((t) => [t.label, t]));
  const nowByLabel = new Map(now.tabs.map((t) => [t.label, t]));

  const added = now.tabs.filter((t) => !beforeByLabel.has(t.label)).map((t) => t.label);
  const removed = before.tabs.filter((t) => !nowByLabel.has(t.label)).map((t) => t.label);
  const changed = now.tabs
    .filter((t) => {
      const prev = beforeByLabel.get(t.label);
      return prev && !sameTab(prev, t);
    })
    .map((t) => t.label);

  if (added.length) parts.push(`added ${added.map((l) => `${l} tab`).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map((l) => `${l} tab`).join(', ')}`);
  if (changed.length) parts.push(`changed ${changed.map((l) => `${l} tab`).join(', ')}`);

  if (parts.length === 0) return 'No changes';
  const summary = capitalize(parts.join('; '));
  return summary.length > 200 ? summary.slice(0, 197) + '…' : summary;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
