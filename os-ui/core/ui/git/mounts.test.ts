/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui/git
 * FEATURE:    The MOUNTS — a shared git affordance that is on no page does not exist
 * USER STORY: As a user on any builder artefact I want the same git line in the header and the
 *             same "clone this repository" card, so "everything lives in git" is something I can
 *             see and act on rather than something the docs claim (checklist G6, E10).
 * ARCHITECTURE:
 *   - A test may not import a `.tsx`, so the surfaces are read as TEXT — the same technique
 *     `tabs/dashboards/lib/git/boot.test.ts` uses for `instrumentation.ts`. That is a feature
 *     here: it measures the MOUNT, which is exactly what was missing. Both components were
 *     fully built and unit-tested (`git-view.test.ts`, `core/infra/git-clone.test.ts`) while
 *     `CloneRepository` was on no page at all and the badge on only two of five.
 *   - The kind string in each mount is checked against the component's own union, so a mount
 *     cannot pass a kind the badge does not accept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** os-ui's root, from this test's own location (`core/ui/git/`). */
const UI = join(import.meta.dirname, '..', '..', '..');

const read = (rel: string): string => {
  const p = join(UI, rel);
  assert.ok(existsSync(p), `${rel} must exist — if a surface was renamed, move the mount with it`);
  return readFileSync(p, 'utf8');
};

/** The five detail surfaces, one per git-backed object kind a user can open. */
const SURFACES: { rel: string; kind: string }[] = [
  { rel: 'tabs/data/ui/DataBuilder.tsx', kind: 'dataset' },
  { rel: 'tabs/metrics/ui/MetricBuilder.tsx', kind: 'metric' },
  { rel: 'tabs/dashboards/ui/DashboardBuilder.tsx', kind: 'dashboard' },
  { rel: 'tabs/agents/ui/SystemView.tsx', kind: 'agent-system' },
  { rel: 'tabs/software/ui/SoftwareBuilder.tsx', kind: 'software' },
];

test('G6: every detail surface mounts <GitHeadBadge/> with its own kind', () => {
  for (const { rel, kind } of SURFACES) {
    const text = read(rel);
    assert.match(text, /from '@core\/ui\/git\/GitHeadBadge'/, `${rel} must import the shared badge`);
    assert.ok(
      new RegExp(`<GitHeadBadge\\s+kind="${kind}"`).test(text),
      `${rel} must mount <GitHeadBadge kind="${kind}" …/> — a badge that is on no page tells nobody anything`,
    );
  }
});

test('G6: the kinds the surfaces mount are all accepted by the badge’s own union', () => {
  const badge = read('core/ui/git/GitHeadBadge.tsx');
  const union = badge.slice(badge.indexOf('kind:'), badge.indexOf(';', badge.indexOf('kind:')));
  for (const { kind, rel } of SURFACES) {
    assert.ok(union.includes(`'${kind}'`), `${rel} mounts kind="${kind}", which GitHeadBadgeProps does not accept`);
  }
});

test('E10: every detail surface mounts <CloneRepository/> with the object’s domain', () => {
  for (const { rel } of SURFACES) {
    const text = read(rel);
    assert.match(text, /from '@core\/ui\/git-clone\/CloneRepository'/, `${rel} must import the clone card`);
    assert.match(
      text,
      /<CloneRepository domain=\{[^}]+\}/,
      `${rel} must mount <CloneRepository domain={…} /> — the clone command was built, tested and mounted nowhere`,
    );
  }
});

test('E10: the card is passed a DOMAIN, never a hardcoded string — the command must be the object’s own', () => {
  for (const { rel } of SURFACES) {
    const mount = /<CloneRepository domain=\{([^}]+)\}/.exec(read(rel))?.[1] ?? '';
    assert.match(mount.trim(), /^[A-Za-z_$][\w$]*(\?)?\.domain$/, `${rel}: the domain must come off the record (got '${mount.trim()}')`);
  }
});
