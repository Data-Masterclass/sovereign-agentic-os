/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       software
 * FEATURE:    The tab-agnostic context feed (ContextGrants · Ask the OS) narrows to the ACTIVE domain
 * USER STORY: As an admin in four domains I want the Choose-Context picker to offer the domain I am
 *             working in — and, when I deliberately chose "All domains", to keep offering them all.
 * ARCHITECTURE:
 *   - `available-context.ts` is server-only and imports five tabs' stores, so this test does NOT
 *     import it. It pins the narrowing where it is decidable: the shared predicate the module
 *     applies (`@core/kernel/domain-scope`) plus a SOURCE tripwire that the module really applies
 *     it to its items and passes the active domain to `listFolders`.
 *   - The tripwire exists because the defect it guards is an OMISSION: the previous code read
 *     `principal.domains` and simply never mentioned the active domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inDomainScope, narrowToDomainScope } from '@core/kernel/domain-scope';

const ACTIVE = 'agentic-leader-autumn-winter-2026-2027';
const FOREIGN = 'agentic-leader-q3-2026';

/**
 * The source with comments stripped. A NEGATIVE source assertion must look at code only:
 * the prose that explains why a call is written one way legitimately quotes the other way,
 * and a grep that cannot tell the two apart fails on its own documentation.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Rows shaped as `forKind` builds them, across two of a four-domain admin's domains. */
const rows = [
  { id: 'ds_mine', name: 'Autumn campaigns', scope: 'personal' as const, domain: ACTIVE, folder: '/' },
  { id: 'ds_foreign', name: 'Q3 campaigns', scope: 'personal' as const, domain: FOREIGN, folder: '/q3' },
  { id: 'ds_shared', name: 'Domain revenue', scope: 'domain' as const, domain: ACTIVE, folder: '/' },
  { id: 'ds_shared_foreign', name: 'Q3 revenue', scope: 'domain' as const, domain: FOREIGN, folder: '/' },
  { id: 'ds_product', name: 'Certified margins', scope: 'marketplace' as const, domain: FOREIGN },
];

test('CONTEXT-DOMAIN: with an active domain, only that domain’s items (plus marketplace) are offered', () => {
  const kept = narrowToDomainScope(rows, ACTIVE).map((r) => r.id);
  assert.deepEqual(kept, ['ds_mine', 'ds_shared', 'ds_product']);
});

test('CONTEXT-DOMAIN: with NO active domain ("All domains") behaviour is unchanged', () => {
  assert.equal(narrowToDomainScope(rows, null).length, rows.length);
});

test('CONTEXT-DOMAIN-TRIPWIRE: the feed module narrows its items and its folder rows', () => {
  const src = readFileSync(join(process.cwd(), 'tabs/software/lib/available-context.ts'), 'utf8');
  assert.match(src, /from '@core\/kernel\/domain-scope'/, 'it uses the shared predicate');
  assert.match(src, /narrowToDomainScope\(/, 'and applies it to the items');
  assert.match(src, /activeDomain/, 'and knows about the active domain at all');
  assert.match(src, /inDomainScope\(/, 'and narrows the FOLDER rows with the same predicate');
  assert.ok(
    !/listFolders\([^)]*activeDomain/.test(codeOnly(src)),
    'never via listFolders\' activeDomain option, which drops a domainless row (M6)',
  );
});

test('CONTEXT-DOMAIN: a domainless folder row / item is kept by the predicate the module uses', () => {
  // The asymmetry this pins: `core/folders`' own `activeDomain` filter drops an unstamped row,
  // the feed's predicate keeps it. The feed must use the predicate, or an unassigned folder
  // vanishes from the picker while its items are still listed.
  assert.equal(inDomainScope({ scope: 'personal', domain: '' }, ACTIVE), true);
  assert.equal(inDomainScope({ scope: 'domain', domain: '' }, ACTIVE), true);
});
