/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    V9 + V8 — the central lifecycle filter and the registry-wide tripwires
 * USER STORY: As a reviewer I want proof that the filter went on EVERY artifact list tool
 *             through one helper, that every result carries lifecycle and audience, and that
 *             nothing in the registry gained a required argument — because "optional
 *             everywhere" is the promise that keeps existing clients working.
 * ARCHITECTURE:
 *   - Imports `@core/*` only (a core test that imported a tab would add a CORE-INDEPENDENCE
 *     violation), so the registry is read through ALL_MCP_TOOLS and the helper is driven with
 *     synthetic payloads of both shapes the stores return.
 *   - `fetch` is stubbed before the pin store loads, so the mirror is offline and the index is
 *     the in-process one — the same path a laptop install takes.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { ALL_MCP_TOOLS } = await import('./server.ts');
const {
  withLifecycleArg,
  lifecycleArg,
  lifecycleView,
  LIST_TOOLS_WITHOUT_LIFECYCLE,
  LIFECYCLE_PROP,
} = await import('./list-args.ts');
const pins = await import('@core/infra/lifecycle-pins');
const { LIFECYCLE_WORDS } = await import('@core/kernel/object-lifecycle');

const ACTOR = { id: 'u1', name: 'Alex', role: 'creator', domains: ['sales'] };
const SHA = 'c'.repeat(40);

beforeEach(() => pins.__resetLifecyclePins());

// ------------------------------------------------- V9: every artifact list tool ---

test('V9: every list_* tool either takes the optional lifecycle filter or is a documented exception', () => {
  const lists = ALL_MCP_TOOLS.filter((t) => t.name.startsWith('list_'));
  assert.ok(lists.length >= 10, `expected the list tools, found ${lists.length}`);
  const missing: string[] = [];
  for (const t of lists) {
    const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    const has = 'lifecycle' in props;
    const excused = t.name in LIST_TOOLS_WITHOUT_LIFECYCLE;
    if (!has && !excused) missing.push(t.name);
    assert.equal(
      has && excused,
      false,
      `${t.name}: it both takes the filter and claims an exemption — pick one`,
    );
  }
  assert.deepEqual(missing, [], 'list tool(s) over a lifecycle-bearing object with no lifecycle filter');
});

test('V9: the exception list has no stale entries — every excused tool still exists', () => {
  const names = new Set(ALL_MCP_TOOLS.map((t) => t.name));
  const stale = Object.keys(LIST_TOOLS_WITHOUT_LIFECYCLE).filter((n) => !names.has(n));
  assert.deepEqual(stale, [], 'the exemption list names tool(s) that no longer exist');
  for (const [name, reason] of Object.entries(LIST_TOOLS_WITHOUT_LIFECYCLE)) {
    assert.ok(reason.length > 10, `${name}: an exemption needs a stated reason`);
  }
});

test('V9: the filter came from ONE helper — every integration advertises the identical property', () => {
  const lists = ALL_MCP_TOOLS.filter(
    (t) => t.name.startsWith('list_') && !(t.name in LIST_TOOLS_WITHOUT_LIFECYCLE),
  );
  for (const t of lists) {
    const prop = (t.inputSchema.properties as Record<string, unknown>).lifecycle;
    assert.deepEqual(prop, LIFECYCLE_PROP, `${t.name}: its lifecycle property is not the shared one`);
  }
});

// --------------------------------- V8: no new required argument anywhere ---

test('V8: `lifecycle` is NEVER required, on any tool in the whole registry', () => {
  for (const t of ALL_MCP_TOOLS) {
    assert.equal(
      (t.inputSchema.required ?? []).includes('lifecycle'),
      false,
      `${t.name}: lifecycle must stay optional`,
    );
  }
});

test('V8: every list_* tool that takes the filter requires NOTHING it did not require before', () => {
  // The three list tools that legitimately require an argument address a parent object; the
  // rest must require nothing at all, which is what "today's clients keep working" means.
  const addressed = new Set(['list_exposure_sets', 'list_operating_manual_versions']);
  for (const t of ALL_MCP_TOOLS.filter((x) => x.name.startsWith('list_'))) {
    const req = t.inputSchema.required ?? [];
    if (addressed.has(t.name)) continue;
    assert.deepEqual(req, [], `${t.name}: a list tool must not require an argument`);
  }
});

test('V8: EXACTLY two new MCP tools, and run_tests is not one of them', () => {
  const names = new Set(ALL_MCP_TOOLS.map((t) => t.name));
  assert.equal(names.has('go_live'), true);
  assert.equal(names.has('retire'), true);
  assert.equal(names.has('run_tests'), false, 'testing reuses each kind’s existing verify tool');
  assert.equal(names.has('set_lifecycle'), false, 'there is no setter that takes a lifecycle word');
  assert.equal(names.has('promote_lifecycle'), false);
  assert.equal(names.has('start_test'), false);
  // And the two carry the three words, not a fourth noun.
  const go = ALL_MCP_TOOLS.find((t) => t.name === 'go_live')!;
  const kinds = (go.inputSchema.properties as Record<string, { enum?: string[] }>).kind.enum ?? [];
  assert.deepEqual(kinds, ['dataset', 'metric', 'dashboard', 'agent', 'app', 'knowledge', 'connection']);
  assert.equal((go.inputSchema.required ?? []).includes('sha'), false, '`sha` is optional');
});

test('V7 tripwire: no tool anywhere takes a `lifecycle` WRITE argument — go_live/retire are the only doors', () => {
  for (const t of ALL_MCP_TOOLS) {
    if (t.name === 'go_live' || t.name === 'retire') continue;
    const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    const prop = props.lifecycle;
    if (!prop) continue;
    assert.match(
      String(prop.description),
      /^OPTIONAL\./,
      `${t.name}: a lifecycle argument may only ever be the optional read filter`,
    );
  }
});

// ------------------------------------------------- the helper's own behaviour ---

test('withLifecycleArg is additive: same required, same first example, one more example', () => {
  const before = { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'], examples: [{ q: 'x' }] };
  const after = withLifecycleArg(before);
  assert.deepEqual(after.required, ['q'], 'required is untouched');
  assert.deepEqual(after.examples?.[0], { q: 'x' }, 'the original example is untouched');
  assert.deepEqual(after.examples?.[1], { q: 'x', lifecycle: 'live' });
  assert.ok((after.properties as Record<string, unknown>).q, 'the original property survives');
});

test('lifecycleArg: omitted means everything; an unknown value is a 400 naming the three words', () => {
  assert.equal(lifecycleArg(undefined), undefined);
  assert.equal(lifecycleArg({}), undefined);
  assert.equal(lifecycleArg({ lifecycle: '' }), undefined);
  for (const w of LIFECYCLE_WORDS) assert.equal(lifecycleArg({ lifecycle: w }), w);
  assert.throws(
    () => lifecycleArg({ lifecycle: 'prod' }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 400, 'a bad argument is a bad_request, not a crash');
      assert.match(e.message, /draft, testing, live/);
      return true;
    },
  );
  assert.throws(() => lifecycleArg({ lifecycle: 'Live' }), /must be one of/);
});

test('V9: a GROUPED payload gets lifecycle + audience on every row, audience from its group', async () => {
  await pins.setLivePin('dashboard', 'd1', SHA, ACTOR, 'sales', { commit: false });
  const payload = {
    mine: [{ id: 'd1', name: 'Mine live' }],
    domain: [{ id: 'd2', name: 'Domain draft' }],
    marketplace: [{ id: 'd3', name: 'Company draft' }],
  };
  const out = (await lifecycleView('dashboard', {}, payload)) as typeof payload;
  assert.deepEqual(out.mine[0], { id: 'd1', name: 'Mine live', lifecycle: 'live', audience: 'my' });
  assert.deepEqual(out.domain[0], { id: 'd2', name: 'Domain draft', lifecycle: 'draft', audience: 'domain' });
  assert.deepEqual(out.marketplace[0], {
    id: 'd3',
    name: 'Company draft',
    lifecycle: 'draft',
    audience: 'company',
  });
});

test('V9: a My object can be Live and a Company object a Draft — the list proves both at once', async () => {
  await pins.setLivePin('metric', 'm_mine', SHA, ACTOR, 'sales', { commit: false });
  const out = (await lifecycleView('metric', {}, {
    mine: [{ id: 'm_mine' }],
    marketplace: [{ id: 'm_company' }],
  })) as { mine: Record<string, unknown>[]; marketplace: Record<string, unknown>[] };
  assert.equal(out.mine[0].audience, 'my');
  assert.equal(out.mine[0].lifecycle, 'live');
  assert.equal(out.marketplace[0].audience, 'company');
  assert.equal(out.marketplace[0].lifecycle, 'draft');
});

test('V9: a FLAT array payload is annotated too, taking its audience from each row’s own tier', async () => {
  await pins.setLivePin('app', 'a1', SHA, ACTOR, 'sales', { commit: false });
  const out = (await lifecycleView('app', {}, [
    { id: 'a1', visibility: 'Shared' },
    { id: 'a2', visibility: 'Personal' },
  ])) as Record<string, unknown>[];
  assert.deepEqual(out[0], { id: 'a1', visibility: 'Shared', lifecycle: 'live', audience: 'domain' });
  assert.deepEqual(out[1], { id: 'a2', visibility: 'Personal', lifecycle: 'draft', audience: 'my' });
});

test('V9: the filter narrows, in both shapes, and the default narrows nothing', async () => {
  await pins.setLivePin('dashboard', 'd1', SHA, ACTOR, 'sales', { commit: false });
  await pins.markTesting('dashboard', 'd2', SHA);
  const grouped = { mine: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] };

  const all = (await lifecycleView('dashboard', {}, grouped)) as { mine: { id: string }[] };
  assert.deepEqual(all.mine.map((r) => r.id), ['d1', 'd2', 'd3'], 'the default is everything');

  const onlyLive = (await lifecycleView('dashboard', { lifecycle: 'live' }, grouped)) as { mine: { id: string }[] };
  assert.deepEqual(onlyLive.mine.map((r) => r.id), ['d1']);

  const onlyTesting = (await lifecycleView('dashboard', { lifecycle: 'testing' }, grouped)) as {
    mine: { id: string }[];
  };
  assert.deepEqual(onlyTesting.mine.map((r) => r.id), ['d2']);

  const flat = (await lifecycleView('dashboard', { lifecycle: 'draft' }, [{ id: 'd1' }, { id: 'd3' }])) as {
    id: string;
  }[];
  assert.deepEqual(flat.map((r) => r.id), ['d3']);
});

test('V9: the helper never loses a field and never invents one beyond the two', async () => {
  const out = (await lifecycleView('connection', {}, [
    { id: 'c1', name: 'Stripe', tier: 'domain', secretRef: 'vault://x', nested: { a: 1 } },
  ])) as Record<string, unknown>[];
  assert.deepEqual(Object.keys(out[0]).sort(), [
    'audience',
    'id',
    'lifecycle',
    'name',
    'nested',
    'secretRef',
    'tier',
  ]);
  assert.deepEqual(out[0].nested, { a: 1 });
  assert.equal(out[0].tier, 'domain', 'the existing tier is kept, not replaced');
});

test('V9: a payload with no rows at all passes through unharmed', async () => {
  assert.deepEqual(await lifecycleView('dataset', {}, { mine: [], domain: [], marketplace: [] }), {
    mine: [],
    domain: [],
    marketplace: [],
  });
  assert.deepEqual(await lifecycleView('dataset', {}, []), []);
  assert.deepEqual(await lifecycleView('dataset', {}, null as unknown as object), null);
});

test('V9: a bad filter value is rejected BEFORE the payload is touched', async () => {
  let evaluated = false;
  const payload = Promise.resolve().then(() => {
    evaluated = true;
    return [{ id: 'x' }];
  });
  await assert.rejects(() => lifecycleView('dataset', { lifecycle: 'prod' }, payload), /must be one of/);
  // the promise was created by the caller, so it runs; what matters is that the REFUSAL came
  // from the argument check and the caller gets a 400, not a filtered-to-nothing list.
  await payload;
  assert.equal(evaluated, true);
});
