/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AI catalog classification (lakehouse Expose, Phase B). Offline: mirror/trace/query are
 * unreachable (graceful no-ops), so the in-process registry + snapshot are authoritative,
 * and the LLM is a scripted fake completer injected via the escalate.ts test idiom. Covers
 * batch splitting, validator rejections (hallucinated table, invented category, bad
 * confidence), incremental run-new, override-wins across a re-run, partial/cost-cap, the
 * seed heuristic, and the merged read path.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/core/config';

(config as { externalConnectorsEnabled: boolean }).externalConnectorsEnabled = true;

// Offline-stub every network call so the registry/snapshot stay in-memory.
globalThis.fetch = (async () => {
  throw new Error('offline-stub');
}) as typeof fetch;

const { createConnection, __resetConnections } = await import('../store.ts');
const { refreshCatalogSnapshot, __resetCatalogSnapshots } = await import('./catalog-snapshot.ts');
const {
  runClassification, getMergedClassification, setSeed, overridePlacement, patchTaxonomy,
  hasMeaningfulSchemas, taxonomyForSeed, smartDefaultSeed, validateBatch, chunk, describeRun,
  mergedPlacement, CONFIDENCE_THRESHOLD, BATCH_SIZE, UNSORTED, STARTER_TAXONOMY,
  __resetCatalogClassifications,
} = await import('./catalog-classification.ts');
const { _reset: resetSettings } = await import('../../platform-admin/settings.ts');
const { _reset: resetDomains, createDomain } = await import('../../platform-admin/domains.ts');

const STANDARD = 'sovereign-default';
const REASONING = 'sovereign-reasoning';

const admin = { id: 'a1', name: 'A', domains: ['sales'], role: 'admin' as const };
const builder = { id: 'b1', name: 'B', domains: ['sales'], role: 'builder' as const };

beforeEach(() => {
  __resetConnections();
  __resetCatalogSnapshots();
  __resetCatalogClassifications();
  resetSettings();
  resetDomains();
});

/** A connection + a real snapshot over the given schema→tables map (injected discover). */
async function seedConnection(schemaTables: Record<string, string[]>) {
  const c = await createConnection(admin, {
    name: 'Glue sales',
    template: 'warehouse',
    endpoint: '',
    credential: '',
    warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } },
  });
  const schemas = Object.keys(schemaTables);
  await refreshCatalogSnapshot(c.id, admin, {
    discover: async (_id, _u, opts) => {
      if (!opts.schema) return { ok: true, schemas, tables: [] };
      return { ok: true, schemas: [], tables: schemaTables[opts.schema] ?? [] };
    },
  });
  return c;
}

/** A fake completer that returns a scripted reply per model, recording calls. */
function scriptCaller(reply: (model: string, userMsg: string) => string) {
  const calls: { model: string; userMsg: string }[] = [];
  const caller = async (req: { model: string; messages: { role: string; content: string }[] }) => {
    const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
    calls.push({ model: req.model, userMsg });
    return reply(req.model, userMsg);
  };
  return { caller: caller as never, calls };
}

/** Build a valid array reply that classifies every asked fqn into `category`. */
function replyAll(userMsg: string, category: string, confidence: number, why = 'name match'): string {
  const fqns = userMsg.split('\n').filter((l) => l.includes('.'));
  return JSON.stringify(fqns.map((table) => ({ table, category, confidence, why })));
}

// ─────────────────────────────── pure logic ───────────────────────────────

test('chunk splits into fixed-size batches', () => {
  const items = Array.from({ length: 250 }, (_, i) => `t${i}`);
  const batches = chunk(items, BATCH_SIZE);
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
});

test('hasMeaningfulSchemas: ≥3 non-generic schemas → true; generics ignored', () => {
  assert.equal(hasMeaningfulSchemas(['sales', 'finance', 'hr']), true);
  assert.equal(hasMeaningfulSchemas(['public', 'staging', 'raw', 'dbo']), false); // all generic
  assert.equal(hasMeaningfulSchemas(['sales', 'finance']), false); // only two meaningful
  assert.equal(hasMeaningfulSchemas(['sales', 'finance', 'public', 'raw']), false); // two meaningful
});

test('taxonomyForSeed: source mirrors schemas, os-domains mirrors domains, starter is 10, empty is 1; Unsorted always last', () => {
  const src = taxonomyForSeed('source', { schemas: ['sales', 'finance'] });
  assert.deepEqual(src.map((f) => f.id), ['sales', 'finance', UNSORTED]);

  const doms = taxonomyForSeed('os-domains', { domains: [{ id: 'commerce', name: 'Commerce' }, { id: 'ops', name: 'Ops' }] });
  assert.deepEqual(doms.map((f) => f.name), ['Commerce', 'Ops', 'Unsorted']);

  const starter = taxonomyForSeed('starter');
  assert.equal(starter.length, STARTER_TAXONOMY.length);
  assert.equal(starter[starter.length - 1].id, UNSORTED);

  const empty = taxonomyForSeed('empty');
  assert.deepEqual(empty.map((f) => f.id), [UNSORTED]);
});

test('validateBatch drops hallucinated tables, degrades invented categories to Unsorted, rejects bad confidence', () => {
  const asked = ['public.orders', 'public.customers'];
  const ids = new Set(['orders', 'customer', UNSORTED]);
  const raw = [
    { table: 'public.orders', category: 'orders', confidence: 0.9, why: 'ok' },
    { table: 'public.customers', category: 'invented', confidence: 0.8, why: 'x' }, // unknown id → Unsorted
    { table: 'ghost.table', category: 'orders', confidence: 0.9, why: 'x' }, // hallucination → dropped
    { table: 'public.orders', category: 'orders', confidence: 5, why: 'x' }, // dup + bad conf ignored
  ];
  const v = validateBatch(raw, asked, ids);
  assert.equal(v.accepted.get('public.orders')?.category, 'orders');
  assert.equal(v.accepted.get('public.customers')?.category, UNSORTED); // never invented
  assert.equal(v.hallucinatedDropped, 1);
  assert.deepEqual(v.missing, []);
});

test('validateBatch: an element with missing/out-of-range confidence is rejected (→ missing)', () => {
  const v = validateBatch(
    [{ table: 'a.b', category: 'x', why: 'no conf' }],
    ['a.b'],
    new Set(['x', UNSORTED]),
  );
  assert.equal(v.accepted.size, 0);
  assert.deepEqual(v.missing, ['a.b']);
});

test('validateBatch rejects a non-array (null) honestly', () => {
  const v = validateBatch(null, ['a.b'], new Set([UNSORTED]));
  assert.equal(v.accepted.size, 0);
  assert.deepEqual(v.missing, ['a.b']);
});

test('describeRun is the honest summary (classified/unsorted/escalated/cost-cap)', () => {
  const detail = describeRun(
    { classified: 132, unsorted: 12, batches: 8, escalatedBatches: 3, hallucinatedDropped: 0, enrichedPass2: 5, stoppedEarly: 'Cost cap reached' },
    200,
  );
  assert.match(detail, /132 classified/);
  assert.match(detail, /12 unsorted/);
  assert.match(detail, /3 of 8 batches escalated/);
  assert.match(detail, /5 column-enriched/);
  assert.match(detail, /stopped early after 144 of 200/);
});

test('mergedPlacement: override wins over entry wins over Unsorted floor', () => {
  const doc = {
    connectionId: 'c', taxonomy: [{ id: 'orders', name: 'O' }, { id: UNSORTED, name: 'Unsorted' }],
    entries: { 'a.b': { category: 'orders', confidence: 0.9, why: 'w', model: 'm', classifiedAt: 't' } },
    overrides: { 'a.b': { category: 'unsorted', by: 'u', at: 't' } },
  } as never;
  assert.equal(mergedPlacement(doc, 'a.b').source, 'override');
  const doc2 = { ...(doc as object), overrides: {} } as never;
  assert.equal(mergedPlacement(doc2, 'a.b').source, 'ai');
  assert.equal(mergedPlacement(doc2, 'missing.table').source, 'unsorted');
});

// ─────────────────────────────── seed + read ───────────────────────────────

test('smartDefaultSeed via the merged read: meaningful schemas → source', async () => {
  const c = await seedConnection({ sales: ['orders'], finance: ['ledger'], hr: ['staff'] });
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.suggestedSeed, 'source');
  assert.equal(smartDefaultSeed(null), 'starter');
});

test('smartDefaultSeed: generic schemas → starter', async () => {
  const c = await seedConnection({ public: ['orders'], staging: ['x'], raw: ['y'] });
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.suggestedSeed, 'starter');
});

test('setSeed stores the taxonomy; a builder is denied (admin-only)', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await assert.rejects(() => setSeed(c.id, builder, 'starter'), /Administrator/);
  await setSeed(c.id, admin, 'starter');
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.seed, 'starter');
  assert.equal(merged.taxonomy[merged.taxonomy.length - 1].id, UNSORTED);
});

// ─────────────────────────────── the run ───────────────────────────────

test('run classifies every table into the taxonomy; the merged read reflects it', async () => {
  const c = await seedConnection({ sales: ['orders', 'invoices'] });
  await setSeed(c.id, admin, 'starter');
  const { caller } = scriptCaller((_m, msg) => replyAll(msg, 'orders', 0.95));
  const { tally } = await runClassification(c.id, admin, 'run', { caller, describe: async () => [] });
  assert.equal(tally.classified, 2);
  assert.equal(tally.unsorted, 0);
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.orders'].category, 'orders');
  assert.equal(merged.placements['sales.orders'].source, 'ai');
});

test('batch splitting: >100 tables run in multiple batches at concurrency 2', async () => {
  const tables = Array.from({ length: 230 }, (_, i) => `t${i}`);
  const c = await seedConnection({ sales: tables });
  await setSeed(c.id, admin, 'starter');
  const { caller, calls } = scriptCaller((_m, msg) => replyAll(msg, 'orders', 0.95));
  const { tally } = await runClassification(c.id, admin, 'run', { caller, describe: async () => [] });
  assert.equal(tally.batches, 3); // 100 + 100 + 30
  assert.equal(calls.length, 3);
  assert.equal(tally.classified, 230);
});

test('a hallucinated table in the reply is dropped and counted in the run detail', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'starter');
  const { caller } = scriptCaller((_m, msg) => {
    const fqns = msg.split('\n').filter((l) => l.includes('.'));
    return JSON.stringify([
      ...fqns.map((table) => ({ table, category: 'orders', confidence: 0.9, why: 'ok' })),
      { table: 'ghost.table', category: 'orders', confidence: 0.9, why: 'hallucinated' },
    ]);
  });
  const { tally } = await runClassification(c.id, admin, 'run', { caller, describe: async () => [] });
  assert.equal(tally.hallucinatedDropped, 1);
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['ghost.table'], undefined); // never entered
});

test('a table the batches leave out is retried once, then lands in Unsorted not-classified', async () => {
  const c = await seedConnection({ sales: ['orders', 'ghost'] });
  await setSeed(c.id, admin, 'starter');
  // Reply ONLY for 'orders', always omit 'ghost' — even on the remainder retry.
  const { caller } = scriptCaller((_m, msg) => {
    const fqns = msg.split('\n').filter((l) => l.includes('.') && l.includes('orders'));
    return JSON.stringify(fqns.map((table) => ({ table, category: 'orders', confidence: 0.9, why: 'ok' })));
  });
  await runClassification(c.id, admin, 'run', { caller, describe: async () => [] });
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.ghost'].category, UNSORTED);
  assert.equal(merged.placements['sales.ghost'].why, 'not-classified');
});

test('incremental run-new classifies only tables with no entry (added since the last run)', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'starter');
  const first = scriptCaller((_m, msg) => replyAll(msg, 'orders', 0.95));
  await runClassification(c.id, admin, 'run', { caller: first.caller, describe: async () => [] });

  // A refresh adds a new table.
  await refreshCatalogSnapshot(c.id, admin, {
    discover: async (_id, _u, opts) =>
      opts.schema ? { ok: true, schemas: [], tables: ['orders', 'shipments'] } : { ok: true, schemas: ['sales'], tables: [] },
  });

  const second = scriptCaller((_m, msg) => replyAll(msg, 'logistics', 0.9));
  await runClassification(c.id, admin, 'run-new', { caller: second.caller, describe: async () => [] });

  // Only the NEW table went to the model in run-new.
  assert.equal(second.calls.length, 1);
  assert.match(second.calls[0].userMsg, /sales\.shipments/);
  assert.doesNotMatch(second.calls[0].userMsg, /sales\.orders/);
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.orders'].category, 'orders'); // untouched
  assert.equal(merged.placements['sales.shipments'].category, 'logistics');
});

test('an override wins forever — a full re-run never overwrites it', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'starter');
  const runCaller = scriptCaller((_m, msg) => replyAll(msg, 'orders', 0.95));
  await runClassification(c.id, admin, 'run', { caller: runCaller.caller, describe: async () => [] });

  // Human moves it to 'financial'.
  await overridePlacement(c.id, admin, 'sales.orders', 'financial');
  let merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.orders'].category, 'financial');
  assert.equal(merged.placements['sales.orders'].source, 'override');

  // Re-run tries to put it back in 'orders' — the override must still win, and the model
  // must not even be asked about the overridden table.
  const rerun = scriptCaller((_m, msg) => replyAll(msg, 'orders', 0.99));
  await runClassification(c.id, admin, 'run', { caller: rerun.caller, describe: async () => [] });
  merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.orders'].source, 'override');
  assert.equal(merged.placements['sales.orders'].category, 'financial');
  assert.doesNotMatch(rerun.calls[0]?.userMsg ?? '', /sales\.orders/);
});

test('override rejects a folder not in the taxonomy (never invented)', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'starter');
  await assert.rejects(() => overridePlacement(c.id, admin, 'sales.orders', 'not-a-folder'), /Unknown folder/);
});

test('partial / cost-cap: a throwing gateway stops the run, remainder → Unsorted, detail is honest', async () => {
  const c = await seedConnection({ sales: ['a', 'b', 'c'] });
  await setSeed(c.id, admin, 'starter');
  const { caller } = scriptCaller(() => { throw new Error('Cost cap reached: tenant'); });
  const { tally } = await runClassification(c.id, admin, 'run', { caller, describe: async () => [] });
  assert.ok(tally.stoppedEarly);
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.a'].category, UNSORTED);
  assert.match(merged.lastRunDetail ?? '', /stopped early/);
});

test('Pass 2: a sub-threshold table is column-enriched and re-placed above threshold', async () => {
  const c = await seedConnection({ sales: ['xyztab'] });
  await setSeed(c.id, admin, 'starter');
  // Pass 1 → low confidence (below threshold); Pass 2 (enrichment) → confident 'customer'.
  // Pass-2 lines look like "sales.xyztab :: email, date" — reply with the fqn before " ::".
  const { caller } = scriptCaller((_m, msg) => {
    if (msg.includes('using their columns')) {
      const fqns = msg.split('\n').map((l) => l.split(' :: ')[0].trim()).filter((l) => l.includes('.'));
      return JSON.stringify(fqns.map((table) => ({ table, category: 'customer', confidence: 0.95, why: 'columns show email' })));
    }
    return replyAll(msg, UNSORTED, 0.2, 'unclear name');
  });
  const { tally } = await runClassification(c.id, admin, 'run', {
    caller,
    describe: async () => [{ name: 'email', type: 'varchar' }, { name: 'signup_date', type: 'date' }],
  });
  assert.equal(tally.enrichedPass2, 1);
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.xyztab'].category, 'customer');
});

test('escalation: a malformed standard reply escalates once to reasoning (per-batch)', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'starter');
  const { caller, calls } = scriptCaller((model, msg) =>
    model === STANDARD ? 'not json at all' : replyAll(msg, 'orders', 0.95),
  );
  const { tally } = await runClassification(c.id, admin, 'run', {
    caller, standardModel: STANDARD, reasoningModel: REASONING, describe: async () => [],
  });
  assert.equal(tally.escalatedBatches, 1);
  assert.deepEqual(calls.map((x) => x.model), [STANDARD, REASONING]);
  const merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.orders'].category, 'orders');
});

test('patchTaxonomy adds a folder (admin-only); a removed folder degrades entries to Unsorted at read', async () => {
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'empty'); // just Unsorted
  await assert.rejects(() => patchTaxonomy(c.id, builder, [{ id: 'x', name: 'X' }]), /Administrator/);
  await patchTaxonomy(c.id, admin, [{ id: 'orders', name: 'Orders' }]);
  const { caller } = scriptCaller((_m, msg) => replyAll(msg, 'orders', 0.95));
  await runClassification(c.id, admin, 'run', { caller, describe: async () => [] });
  let merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.placements['sales.orders'].category, 'orders');
  // Remove 'orders' from the taxonomy — the entry now reads as Unsorted (unknown id).
  await patchTaxonomy(c.id, admin, []);
  merged = await getMergedClassification(c.id, admin);
  assert.equal(merged.taxonomy.some((t) => t.id === 'orders'), false);
});

test('CONFIDENCE_THRESHOLD is the exported 0.7 constant', () => {
  assert.equal(CONFIDENCE_THRESHOLD, 0.7);
});

test('os-domains seed builds folders from the real domain list', async () => {
  createDomain({ name: 'Commerce', owner: 'a1' });
  createDomain({ name: 'Operations', owner: 'a1' });
  const c = await seedConnection({ sales: ['orders'] });
  await setSeed(c.id, admin, 'os-domains');
  const merged = await getMergedClassification(c.id, admin);
  const names = merged.taxonomy.map((t) => t.name);
  assert.ok(names.includes('Commerce'));
  assert.ok(names.includes('Operations'));
  assert.equal(merged.taxonomy[merged.taxonomy.length - 1].id, UNSORTED);
});
