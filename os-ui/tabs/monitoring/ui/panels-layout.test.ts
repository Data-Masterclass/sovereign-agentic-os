/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring panels stay inside a 390 px viewport
 * USER STORY: As an operator on a phone I want badges and the backup/alert rows to wrap inside the
 *             page instead of running off its right edge.
 * ARCHITECTURE: a static check of PanelsView.tsx and the tab stylesheet: every panel view renders
 *   inside `.mon-panels`, whose rules let a badge wrap, let grid cells shrink (min-width: 0) and
 *   stack the row grids below 640 px. Twin: the rules are asserted to be scoped to `.mon-panels`, so
 *   removing the wrapper class from a view fails the first assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('./PanelsView.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../../app/(govern)/monitoring/monitoring.css', import.meta.url), 'utf8');

test('each panel view renders inside the .mon-panels container', () => {
  for (const fn of ['AgentsPanels', 'DataPanels', 'PlatformPanels', 'FilesPanels', 'KnowledgePanels', 'KpisPanels', 'DashboardsPanels']) {
    const body = view.slice(view.indexOf(`function ${fn}(`));
    const ret = body.slice(body.indexOf('return ('), body.indexOf('return (') + 80);
    assert.match(ret, /className="mon-panels"/, `${fn} must render inside .mon-panels`);
  }
});

test('the per-rule and per-file rows stack on a phone', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.match(phone, /\.mon-panels \.mon-tr-prule[\s\S]*grid-template-columns:\s*1fr\b/);
  assert.match(phone, /\.mon-panels \.mon-tr-pfile[\s\S]*grid-template-columns:\s*1fr\b/);
});

test('inside .mon-panels a badge wraps, cells shrink, rows stack on a phone', () => {
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    assert.ok(i >= 0, `missing rule ${sel}`);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(rule('.mon-panels .badge'), /white-space:\s*normal/);
  assert.match(rule('.mon-panels .badge'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.mon-panels .mon-tr > *'), /min-width:\s*0/);
  assert.match(rule('.mon-panels'), /max-width:\s*100%/);
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.match(phone, /\.mon-panels \.mon-tr-pfail[\s\S]*grid-template-columns:\s*1fr\b/);
});
