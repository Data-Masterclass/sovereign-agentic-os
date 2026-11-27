/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The zero-match grant warning as catalog keys reads exactly as the English sentence did
 * USER STORY: As a team author I want the "this grant contains 0 files" note in my language — and in English,
 *             word for word what it said before.
 * ARCHITECTURE: Renders `lib/grant-messages.ts` through the real `messages/<locale>/agents.json` catalogs and
 *   compares the English with the untouched English functions in `lib/grant-apply.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogText, CATALOG_LOCALES } from '@core/testing/catalog-text';
import {
  zeroMatchWarning, zeroMatchFolderGrants, FOLDERED_GRANT_KINDS,
  type FolderGrantCoverage, type FolderedGrantKind,
} from '@tabs/agents/lib/grant-apply';
import { parseSystem, type System } from '@tabs/agents/lib/system-schema';
import { setFolderGrant } from '@tabs/agents/lib/simple-edit';
import {
  zeroMatchMessages, zeroMatchFolderGrantMessages, renderGrantWarning, type GrantMsg,
} from '@tabs/agents/lib/grant-messages';

const tr = (locale: string) => (key: string, args?: Record<string, string | number>) => catalogText('agents', { key, args }, locale);
const en = tr('en');

const KINDS: FolderedGrantKind[] = ['files', 'data', 'knowledge', 'workflows'];

/** Every coverage shape the warning distinguishes. */
function coverages(): FolderGrantCoverage[] {
  const out: FolderGrantCoverage[] = [];
  for (const scope of ['personal', 'domain'] as const) {
    const other = scope === 'personal' ? 'domain' : 'personal';
    for (const path of ['/', '/invoices']) {
      out.push({ folder: { path, scope }, count: 0, elsewhere: null });
      for (const count of [1, 12, 1500]) {
        out.push({ folder: { path, scope }, count: 0, elsewhere: { path, scope: other, count } });
        out.push({ folder: { path: '/Invoices', scope }, count: 0, elsewhere: { path: '/invoices', scope, count } });
      }
    }
  }
  out.push({ folder: { path: '/x', scope: 'domain' }, count: 3, elsewhere: null });
  return out;
}

test('zeroMatchMessages renders the same English as zeroMatchWarning, for every kind, subject and shape', () => {
  for (const kind of KINDS) {
    for (const subject of ['this', 'named'] as const) {
      for (const cov of coverages()) {
        const want = zeroMatchWarning(kind, cov, subject);
        const msgs = zeroMatchMessages(kind, cov, subject);
        if (want === null) { assert.equal(msgs, null); continue; }
        assert.ok(msgs);
        const got = renderGrantWarning(msgs, en);
        // The one intended difference: ICU writes a count of 1,000+ with a thousands separator.
        assert.equal(got, want.replace('1500', '1,500'), `${kind}/${subject}/${JSON.stringify(cov)}`);
      }
    }
  }
});

test('zeroMatchFolderGrantMessages mirrors zeroMatchFolderGrants', () => {
  const named = (): System => parseSystem('system: { name: Renewals desk, domain: d, visibility: Personal }\nentrypoint: ""\ngrants: {}\nagents: []');
  const FEED = {
    items: [
      { id: 'f_1', scope: 'domain', folder: '/Invoices' },
      { id: 'f_2', scope: 'domain', folder: '/Invoices' },
      { id: 'f_3', scope: 'domain', folder: '/Invoices/2026' },
    ],
  };
  let sys = setFolderGrant(named(), 'files', { path: '/Invoices', scope: 'personal' }, false);
  sys = setFolderGrant(sys, 'files', { path: '/', scope: 'personal' }, false);
  sys = setFolderGrant(sys, 'files', { path: '/Inbox', scope: 'domain' }, false);
  for (const kind of FOLDERED_GRANT_KINDS) {
    const want = zeroMatchFolderGrants(sys, kind, FEED);
    const got = zeroMatchFolderGrantMessages(sys, kind, FEED).map((m) => renderGrantWarning(m, en));
    assert.deepEqual(got, want);
  }
  assert.equal(zeroMatchFolderGrantMessages(sys, 'files', FEED).length, 3);
});

test('every key the warning uses exists and renders in all seven languages', () => {
  const msgs: GrantMsg[][] = [];
  for (const kind of KINDS) for (const subject of ['this', 'named'] as const) for (const cov of coverages()) {
    const m = zeroMatchMessages(kind, cov, subject);
    if (m) msgs.push(m);
  }
  for (const locale of CATALOG_LOCALES) {
    for (const m of msgs) {
      const text = renderGrantWarning(m, tr(locale));
      assert.ok(text.length > 0 && !text.includes('{'), `${locale}: ${text}`);
    }
  }
});
