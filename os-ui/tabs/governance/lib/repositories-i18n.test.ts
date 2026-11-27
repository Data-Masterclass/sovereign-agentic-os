/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        governance
 * FEATURE:    Governance → Repositories in seven languages — the catalog twins of the view-model's English
 * USER STORY: As an English user I want the Repositories screen to read exactly as before i18n, and as a German
 *             or Polish user I want every mirror verdict, roll-up and layout word in my language — so no message
 *             the view-model returns may be missing from any catalog.
 * ARCHITECTURE:
 *   - Renders each `{ key, args }` the pure module returns through `messages/<locale>/governance.json` with
 *     the same ICU engine next-intl uses (`@core/testing/catalog-text`) and compares the English rendering
 *     with the module's own English string, byte for byte. No fetch, no DOM, no `.tsx`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mirrorState,
  repoViews,
  repoSummaryLine,
  repoSummaryMessage,
  layoutViews,
  type RepoRow,
  type LayoutRow,
} from '@tabs/governance/lib/repositories';
import { catalogText, CATALOG_LOCALES } from '@core/testing/catalog-text';

const text = (v: { key: string; args?: Record<string, string | number> }, locale = 'en') => catalogText('governance', v, locale);

const base: RepoRow = {
  domain: 'sales',
  head: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456',
  commits: 12,
  countTruncated: false,
  lastAuthor: 'Amir Example',
  lastSubject: 'agents(sales): set schedule',
  lastAt: '2026-11-14T09:00:00.000Z',
  mirror: null,
};
const url = 'https://git.example/sales.git';

const MIRROR_CASES: RepoRow[] = [
  base,
  { ...base, mirror: { domain: 'sales', url, lastSha: base.head!, lastPushedAt: '2026-11-14T09:00:05.000Z' } },
  { ...base, mirror: { domain: 'sales', url, lastSha: base.head! } },
  { ...base, mirror: { domain: 'sales', url, lastSha: '3f81d0c1122334455667788990aabbccddeeff00', lastPushedAt: '2026-11-01T06:00:00.000Z' } },
  { ...base, mirror: { domain: 'sales', url, lastSha: '3f81d0c1122334455667788990aabbccddeeff00' } },
  { ...base, mirror: { domain: 'sales', url } },
  { ...base, mirror: { domain: 'sales', url, lastError: 'auth failed', lastErrorAt: '2026-11-14T09:01:00.000Z' } },
  { ...base, mirror: { domain: 'sales', url, lastError: 'auth failed' } },
];

const LAYOUT: LayoutRow[] = [
  { kind: 'dataset', label: 'dbt model', paths: ['models/'], personalLane: 'models/personal/<uid>/', writer: { state: 'committed', via: 'tabs/data/lib/dbt/commit.ts', since: 'B1' } },
  { kind: 'dashboard', label: 'dashboard-as-code', paths: ['dashboards/'], personalLane: null, writer: { state: 'landing', via: 'tabs/dashboards/lib/git/commit.ts', stream: 'D' } },
  { kind: 'connection-config', label: 'connection configuration', paths: ['connections/<slug>.yml'], personalLane: null, writer: { state: 'backlog', reason: 'no git writer yet' } },
];

test('every mirror verdict renders, in English, exactly the old detail line', () => {
  for (const row of MIRROR_CASES) {
    const { detail, detailMsg } = mirrorState(row);
    assert.equal(text(detailMsg), detail);
    const [view] = repoViews([row]);
    assert.equal(text(view.mirrorDetailMsg), view.mirrorDetail);
  }
});

test('the roll-up message renders, in English, exactly the old summary line', () => {
  const failing = { ...base, domain: 'finance', mirror: { domain: 'finance', url, lastError: 'x' } };
  const behind = { ...base, domain: 'hr', mirror: { domain: 'hr', url } };
  const sets: RepoRow[][] = [
    [],
    [base],
    [base, failing],
    [base, failing, { ...failing, domain: 'ops' }],
    [base, behind],
    [base, behind, { ...behind, domain: 'it' }, failing],
    [{ ...base, commits: 1 }],
  ];
  for (const rows of sets) assert.equal(text(repoSummaryMessage(rows)), repoSummaryLine(rows));
});

test('the layout status words and writer details render, in English, exactly as before', () => {
  const views = layoutViews(LAYOUT);
  for (const v of views) {
    assert.equal(text({ key: v.statusKey }), v.status);
    if (v.detailMsg) assert.equal(text(v.detailMsg), v.detail);
  }
  assert.equal(views[2].detailMsg, null, 'a backlog reason is the server\'s own text, shown verbatim');
});

test('every message the module returns exists and formats in all seven languages', () => {
  const msgs = [
    ...MIRROR_CASES.map((r) => mirrorState(r).detailMsg),
    repoSummaryMessage([]),
    repoSummaryMessage([base, { ...base, domain: 'x', mirror: { domain: 'x', url, lastError: 'e' } }, { ...base, domain: 'y', mirror: { domain: 'y', url } }]),
    ...layoutViews(LAYOUT).flatMap((v) => [{ key: v.statusKey }, ...(v.detailMsg ? [v.detailMsg] : [])]),
  ];
  for (const locale of CATALOG_LOCALES) {
    for (const m of msgs) {
      const out = text(m, locale);
      assert.ok(out.length > 0, `${locale}: ${m.key} is empty`);
      for (const v of Object.values(m.args ?? {})) {
        // A free-text argument (url, error, sha) must reach the reader in every language.
        if (typeof v === 'string' && v.length > 3) assert.ok(out.includes(v), `${locale}: ${m.key} drops "${v}"`);
      }
    }
  }
});
