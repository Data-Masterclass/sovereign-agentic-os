/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE issue → control mapping for the COMPOSE UI (AppSpec Phase 4a).
 *
 * `parseAppSpec` + `validateAppSpec` return typed `{ path, reason, fix }` issues over dotted spec
 * paths (`tabs[2].body.config.columns[0].field`, `tabs[1].label`, `name`, …). The composer must
 * surface each issue INLINE next to the control that owns it. This module turns a raw issue path
 * into a structured `IssueTarget` — which tab (by index), and which config SLOT/field — so the React
 * layer can render the message under the right control. Everything is a pure string parse → tested.
 */

import type { SpecIssue } from './schema.ts';
import type { SpecWarning } from './validate.ts';

/** Where an issue lands in the editor. `scope:'app'` = a top-level field (name/description/theme);
 *  `scope:'tab'` = inside a tab (by index), optionally on a named config `slot` (+ item field);
 *  `scope:'function'` = inside the Advanced `functions[]` editor (by index). */
export type IssueTarget =
  | { scope: 'app'; field: string }
  | { scope: 'tab'; tabIndex: number; slot?: string; field?: string }
  | { scope: 'function'; fnIndex: number }
  | { scope: 'unknown' };

/** An issue/warning already resolved to its editor location — what the form renders inline. */
export type LocatedIssue = { issue: SpecIssue | SpecWarning; level: 'error' | 'warning'; target: IssueTarget };

const TAB_RE = /^tabs\[(\d+)\]/;
const FN_RE = /^functions\[(\d+)\]/;
const CONFIG_RE = /body\.config\.([A-Za-z0-9_]+)/;

/** Parse ONE dotted spec path into an `IssueTarget`. */
export function targetForPath(path: string): IssueTarget {
  if (path === '') return { scope: 'unknown' };

  // A governed-function issue: `functions[3].expr`, `functions[0].source.datasetId`, …
  const fnMatch = FN_RE.exec(path);
  if (fnMatch) return { scope: 'function', fnIndex: Number(fnMatch[1]) };
  if (path === 'functions') return { scope: 'app', field: 'functions' };

  const tabMatch = TAB_RE.exec(path);
  if (!tabMatch) {
    // A top-level app field: `name`, `description`, `theme.css`, `version`.
    const field = path.split(/[.[]/)[0];
    return { scope: 'app', field };
  }

  const tabIndex = Number(tabMatch[1]);
  const rest = path.slice(tabMatch[0].length); // e.g. `.label`, `.body.config.columns[0].field`

  // A tab-level (non-config) field: `.label`, `.id`, `.icon`, `.roleGate`, `.stories[0]...`.
  if (rest.startsWith('.label')) return { scope: 'tab', tabIndex, slot: 'label' };
  if (rest.startsWith('.id')) return { scope: 'tab', tabIndex, slot: 'id' };
  if (rest.startsWith('.icon')) return { scope: 'tab', tabIndex, slot: 'icon' };
  if (rest.startsWith('.roleGate')) return { scope: 'tab', tabIndex, slot: 'roleGate' };
  if (rest.startsWith('.stories')) return { scope: 'tab', tabIndex, slot: 'stories' };
  if (rest.startsWith('.body.pattern')) return { scope: 'tab', tabIndex, slot: 'pattern' };
  // A custom-block body field: `.body.html`, `.body.css`, `.body.js`, `.body.data...`.
  if (rest.startsWith('.body.html')) return { scope: 'tab', tabIndex, slot: 'html' };
  if (rest.startsWith('.body.css')) return { scope: 'tab', tabIndex, slot: 'css' };
  if (rest.startsWith('.body.js')) return { scope: 'tab', tabIndex, slot: 'js' };
  if (rest.startsWith('.body.data')) return { scope: 'tab', tabIndex, slot: 'data' };

  // A config slot: `.body.config.<slot>` (optionally an item `.field` deeper).
  const cfg = CONFIG_RE.exec(rest);
  if (cfg) {
    const slot = cfg[1];
    // Pull the leaf field name if the issue is on a column/field item's `.field`.
    const fieldMatch = /\.field\b/.test(rest) ? 'field' : undefined;
    return { scope: 'tab', tabIndex, slot, ...(fieldMatch ? { field: fieldMatch } : {}) };
  }

  // Something inside a tab we didn't name precisely — still attribute it to the tab.
  return { scope: 'tab', tabIndex };
}

/** Locate every issue + warning to its editor target, tagged by level. */
export function locateIssues(issues: SpecIssue[], warnings: SpecWarning[]): LocatedIssue[] {
  return [
    ...issues.map((issue): LocatedIssue => ({ issue, level: 'error', target: targetForPath(issue.path) })),
    ...warnings.map((issue): LocatedIssue => ({ issue, level: 'warning', target: targetForPath(issue.path) })),
  ];
}

/** The located issues that belong to a given tab index (any slot). */
export function issuesForTab(located: LocatedIssue[], tabIndex: number): LocatedIssue[] {
  return located.filter((l) => l.target.scope === 'tab' && l.target.tabIndex === tabIndex);
}

/** The located issues that belong to a given tab + config slot (e.g. the `columns` control). */
export function issuesForSlot(located: LocatedIssue[], tabIndex: number, slot: string): LocatedIssue[] {
  return located.filter((l) => l.target.scope === 'tab' && l.target.tabIndex === tabIndex && l.target.slot === slot);
}

/** The app-level located issues (name/description/theme). */
export function appLevelIssues(located: LocatedIssue[]): LocatedIssue[] {
  return located.filter((l) => l.target.scope === 'app' || l.target.scope === 'unknown');
}

/** The located issues that belong to a given governed function (by index) — for the Advanced editor. */
export function issuesForFunction(located: LocatedIssue[], fnIndex: number): LocatedIssue[] {
  return located.filter((l) => l.target.scope === 'function' && l.target.fnIndex === fnIndex);
}

/** All function-scoped located issues (shown in the Advanced functions section). */
export function functionIssues(located: LocatedIssue[]): LocatedIssue[] {
  return located.filter((l) => l.target.scope === 'function');
}

/** Whether any BLOCKING error exists anywhere (the save button reads this). */
export function hasBlockingErrors(located: LocatedIssue[]): boolean {
  return located.some((l) => l.level === 'error');
}
