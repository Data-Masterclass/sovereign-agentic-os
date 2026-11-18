/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The grant picker's feed is scoped to the SYSTEM's domain, not to everything the caller can see
 * USER STORY: As an admin in four domains, editing a system in one of them, I only want that domain's
 *             folders and artifacts offered — while a legacy grant pointing elsewhere stays visible.
 * ARCHITECTURE:
 *   - Tests `tabs/agents/lib/grant-feed.ts` directly: a test cannot import a `route.ts`
 *     (it pulls `next/headers` and dies with ERR_MODULE_NOT_FOUND), so the feed assembly
 *     lives in a plain module the route delegates to, and that module is what is pinned here.
 *   - The fixtures are what a 4-domain admin's listers return for TWO domains, mapped exactly
 *     the way the route maps a summary (`domain: <summary>.domain`). No stores are imported —
 *     a tab imports only `@core/*` and itself.
 *   - The last test is a SOURCE tripwire over the route file (read, never imported): the
 *     narrowing is worthless if a later edit stops handing the builder the system's domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGrantFeed, type GrantFeedInput } from '@tabs/agents/lib/grant-feed';

/** The system under edit lives here; the reporter's stray folder lives in FOREIGN. */
const SYSTEM_DOMAIN = 'agentic-leader-autumn-winter-2026-2027';
const FOREIGN = 'agentic-leader-q3-2026';

/**
 * The source with comments stripped. A NEGATIVE source assertion must look at code only:
 * the prose that explains why a call is written one way legitimately quotes the other way,
 * and a grep that cannot tell the two apart fails on its own documentation.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The reporter: an admin in four domains, so every lister spans all four. */
const admin = {
  id: 'alex',
  role: 'admin' as const,
  domains: [SYSTEM_DOMAIN, FOREIGN, 'northpeak', 'platform'],
};

/** What `listFiles(principal)` yields for that admin, mapped as the route maps it. */
function filesFeed(): GrantFeedInput[] {
  return [
    // the system's own domain
    { id: 'file_a', name: 'Autumn brief.md', scope: 'personal', domain: SYSTEM_DOMAIN, folder: '/briefs' },
    { id: 'file_b', name: 'Winter plan.md', scope: 'domain', domain: SYSTEM_DOMAIN, folder: '/plans/2027' },
    // the reporter's stray: a PERSONAL file in another of their domains
    { id: 'file_c', name: 'invoices PDF', scope: 'personal', domain: FOREIGN, folder: '/northpeak/invoices PDF' },
    // another domain's SHARED file
    { id: 'file_d', name: 'Q3 numbers.xlsx', scope: 'domain', domain: FOREIGN, folder: '/q3' },
    // a certified product, homed in the foreign domain — must still be offered
    { id: 'file_e', name: 'Company handbook', scope: 'marketplace', domain: FOREIGN, folder: '/handbook' },
    // an unassigned artifact — no domain at all
    { id: 'file_f', name: 'Unfiled note.md', scope: 'personal', domain: '', folder: '/inbox' },
  ];
}

test('GRANT-FEED: only the SYSTEM domain’s personal items are offered (the reported leak)', () => {
  assert.ok(admin.domains.length === 4, 'the scenario is a four-domain admin');
  const { items } = buildGrantFeed({ items: filesFeed(), domain: SYSTEM_DOMAIN, withFolders: true });
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('file_a'), 'the system domain’s personal file is offered');
  assert.ok(!ids.includes('file_c'), 'another domain’s PERSONAL file is NOT offered');
});

test('GRANT-FEED: only the SYSTEM domain’s domain-scope items are offered', () => {
  const { items } = buildGrantFeed({ items: filesFeed(), domain: SYSTEM_DOMAIN, withFolders: true });
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('file_b'), 'the system domain’s shared file is offered');
  assert.ok(!ids.includes('file_d'), 'another domain’s SHARED file is NOT offered');
});

test('GRANT-FEED: marketplace items still appear, whichever domain they are homed in', () => {
  const { items } = buildGrantFeed({ items: filesFeed(), domain: SYSTEM_DOMAIN, withFolders: true });
  assert.ok(items.some((i) => i.id === 'file_e'), 'a certified product from another domain stays grantable');
});

test('GRANT-FEED: a domainless artifact still appears (an admin must be able to domain-move it)', () => {
  const { items } = buildGrantFeed({ items: filesFeed(), domain: SYSTEM_DOMAIN, withFolders: true });
  assert.ok(items.some((i) => i.id === 'file_f'), 'an unassigned artifact is never hidden');
});

test('GRANT-FEED: the item’s own domain is NOT echoed on the wire', () => {
  const { items } = buildGrantFeed({ items: filesFeed(), domain: SYSTEM_DOMAIN, withFolders: true });
  const a = items.find((i) => i.id === 'file_a') as Record<string, unknown>;
  assert.equal(a.domain, undefined, 'the picker never reads it, so the response does not carry it');
  assert.equal(a.folder, '/briefs', 'the fields the picker DOES read survive');
});

test('GRANT-FEED: folder nodes derive from the NARROWED items — no foreign folder, no foreign ancestor', () => {
  const { folders } = buildGrantFeed({ items: filesFeed(), domain: SYSTEM_DOMAIN, withFolders: true });
  const paths = (folders ?? []).map((f) => f.path);
  assert.ok(paths.includes('/briefs'), 'the system domain’s personal folder is a node');
  assert.ok(paths.includes('/plans') && paths.includes('/plans/2027'), 'ancestors are still synthesized');
  assert.ok(!paths.includes('/northpeak'), 'no foreign ANCESTOR leaks into the tree');
  assert.ok(!paths.includes('/northpeak/invoices PDF'), 'the reported foreign folder is gone');
  assert.ok(!paths.includes('/q3'), 'another domain’s shared folder is gone');
});

test('GRANT-FEED: an explicit registry row from another domain is not re-admitted by the union', () => {
  const { folders } = buildGrantFeed({
    items: filesFeed(),
    domain: SYSTEM_DOMAIN,
    // The route reads these with `{ activeDomain: system.domain }`; this proves the builder
    // does not widen the tree if a foreign row ever reaches it anyway.
    explicitFolders: [
      { path: '/q3', scope: 'domain', domain: FOREIGN },
      { path: '/briefs', scope: 'personal', domain: SYSTEM_DOMAIN },
    ],
    withFolders: true,
  });
  const paths = (folders ?? []).map((f) => f.path);
  assert.ok(paths.includes('/briefs'), 'an in-domain explicit row is kept');
  assert.ok(!paths.includes('/q3'), 'a foreign explicit row is dropped');
});

test('GRANT-FEED: a LEGACY grant outside the system’s domain is still shown, flagged, never dropped', () => {
  const { folders } = buildGrantFeed({
    items: filesFeed(),
    domain: SYSTEM_DOMAIN,
    explicitFolders: [{ path: '/briefs', scope: 'personal', domain: SYSTEM_DOMAIN }],
    // live on system.yaml today: a folder grant into the foreign domain
    grantedFolders: [
      { path: '/northpeak/invoices PDF', scope: 'personal' },
      { path: '/briefs', scope: 'personal' },
    ],
    withFolders: true,
  });
  const legacy = (folders ?? []).find((f) => f.path === '/northpeak/invoices PDF');
  assert.ok(legacy, 'the granted out-of-domain folder is STILL in the feed (not silently dropped)');
  assert.equal(legacy?.scope, 'personal');
  assert.equal(legacy?.outsideDomain, true, 'and it is flagged so the picker can warn');
  const inDomain = (folders ?? []).find((f) => f.path === '/briefs');
  assert.equal(inDomain?.outsideDomain, undefined, 'an in-domain granted folder carries NO warning');
  assert.equal(
    (folders ?? []).filter((f) => f.path === '/briefs').length,
    1,
    'a granted folder already in the tree is not duplicated',
  );
});

test('GRANT-FEED: withFolders=false (connections · metrics · manual) returns items only', () => {
  const out = buildGrantFeed({
    items: [{ id: 'conn_1', name: 'Sales warehouse', scope: 'personal', domain: SYSTEM_DOMAIN }],
    domain: SYSTEM_DOMAIN,
  });
  assert.equal(out.folders, undefined, 'no folder key for a kind that has no folders');
  assert.equal(out.items.length, 1);
});

test('GRANT-FEED: a null target domain narrows nothing (an unassigned system keeps today’s feed)', () => {
  const { items } = buildGrantFeed({ items: filesFeed(), domain: null, withFolders: true });
  assert.equal(items.length, filesFeed().length, 'no domain context ⇒ no narrowing');
});

test('GRANT-FEED-TRIPWIRE: the route really delegates, and really hands over the SYSTEM’s domain', () => {
  // Read, never import: a test that imports a route.ts dies on next/headers.
  const routePath = join(
    process.cwd(),
    'app/api/agents/systems/[id]/grants/available/route.ts',
  );
  const src = readFileSync(routePath, 'utf8');
  assert.match(src, /from '@tabs\/agents\/lib\/grant-feed'/, 'the route imports the feed builder');
  assert.match(src, /buildGrantFeed\(/, 'and calls it');
  assert.match(src, /domain:\s*targetDomain/, 'and passes the system’s domain as the narrowing target');
  assert.match(
    src,
    /domain:\s*f\.domain/,
    'and tags each explicit folder row with its own domain, so the feed can narrow them',
  );
  assert.ok(
    !/listFolders\([^)]*activeDomain/.test(codeOnly(src)),
    'and does NOT use listFolders\' activeDomain option, which drops a domainless row',
  );
  assert.match(src, /grantedFolders\s*=/, 'and hands over the folder grants the system already holds');
});

test('GRANT-FEED: a DOMAINLESS explicit folder row survives the narrowing (M6)', () => {
  // `listFolders(..., { activeDomain })` would have dropped this row; the feed's own predicate
  // keeps an unassigned artifact, and the two must agree or an unstamped folder disappears
  // from the tree while its items are still listed.
  const { folders } = buildGrantFeed({
    items: [],
    domain: SYSTEM_DOMAIN,
    explicitFolders: [
      { path: '/unfiled', scope: 'personal', domain: '' },
      { path: '/elsewhere', scope: 'personal', domain: FOREIGN },
    ],
    withFolders: true,
  });
  const paths = (folders ?? []).map((f) => f.path);
  assert.ok(paths.includes('/unfiled'), 'an unassigned folder row is still offered');
  assert.ok(!paths.includes('/elsewhere'), 'a foreign one is still dropped');
});
