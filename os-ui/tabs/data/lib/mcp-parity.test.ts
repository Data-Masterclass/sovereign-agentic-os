/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    MCP = UI for every data mutation (engine rebuild B4, checklist X8)
 * USER STORY: As a data engineer I want proof that driving the OS MCP and driving the Data tab
 *             produce the SAME repo commit (same files, same author, same OS-Actor trailer) and the
 *             SAME Dagster launch for the same input — so neither door can drift from the other.
 * ARCHITECTURE:
 *   - ONE table-driven test over the eight mutating data tools (nine cases: `set_dataset_sync`
 *     appears twice, once configuring and once CLEARING — review M-1). For each, the MCP handler is driven
 *     through `handleRpc` exactly as a client would, then the store is reset and the SAME input is
 *     passed to the service function the UI route calls (a test may not import a route, so the
 *     service IS the route's half — the routes are thin shells over these functions).
 *   - The git store is the real commit path with an INJECTED committer (the in-memory store): every
 *     file map, author and trailer set is captured. Dagster is a fake client injected through
 *     `__setLaunchDepsForTests`, which both doors' fire-and-forget launch picks up.
 *   - Normalisation is deliberate and narrow: the dataset id (random), ISO timestamps, the
 *     `OS-Request-Id` trailer and the `via <surface>` half of the subject (`ui:` vs `mcp:` is the
 *     ONE thing that must differ). Everything else is compared deep-equal.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse, type ToolError } from '@core/mcp/server';
import * as store from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { runWithSurface } from '@core/infra/request-surface';
import type { CommitTreeOptions, GitAuthor } from '@core/infra/git-store';
import {
  installDataProjectCommitHook,
  awaitDataProjectCommits,
  __setDataProjectGitForTests,
} from '@tabs/data/lib/dbt/commit';
import {
  __setLaunchDepsForTests,
  awaitDataProjectLaunches,
  type LaunchDeps,
} from '@tabs/data/lib/dbt/launch';
import { projectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import type { LaunchInput as DagsterLaunchInput } from '@core/infra/dagster';
import {
  __setMutationDepsForTests,
  createDatasetService,
  commitVersionService,
  transformSilverService,
  buildGoldJoinService,
  defineQualityRulesService,
  runQualityChecksService,
  saveDatasetSyncService,
  syncDatasetNowService,
} from '@tabs/data/lib/mutations-server';

const amir: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
const BASE = 'ds_parity_base';
const PARTNER = 'ds_parity_partner';

/* ------------------------------------------------------------- the observers -- */

type Commit = { domain: string; files: [string, string][]; author: GitAuthor; trailers: Record<string, string>; subject: string };
let commits: Commit[] = [];
let launches: DagsterLaunchInput[] = [];
let uninstall: (() => void) | null = null;

/** Every asset key the generated project declares — what a loaded location would expose. */
async function allKeys(): Promise<{ key: string[]; dependsOn: string[][]; group: string | null; description: string | null }[]> {
  const domains = [...new Set(store.listAllDatasets().map((d) => d.domain).filter(Boolean))];
  const out: string[][] = [];
  for (const domain of domains) {
    const snapshot = await projectSnapshot(domain);
    for (const d of snapshot.datasets) {
      const keys = datasetAssetKeys(snapshot, d.dataset.id);
      out.push(...keys.models.map((m) => m.key), ...keys.dependents);
      if (keys.tested) out.push(keys.tested);
    }
  }
  return out.map((key) => ({ key, dependsOn: [], group: null, description: null }));
}

const fakeDagster: LaunchDeps['dagster'] = {
  launchRun: async (input) => {
    launches.push(input);
    return { ok: true, data: { runId: 'run_fake', status: 'QUEUED' } };
  },
  assetGraph: async () => ({ ok: true, data: await allKeys() }),
  runsForDataset: async () => ({ ok: true, data: [] }),
};

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  __setDataProjectGitForTests(true);
  commits = [];
  launches = [];
  uninstall = installDataProjectCommitHook({
    committer: async (domain, files, opts: CommitTreeOptions) => {
      const subject = opts.message.split('\n')[0];
      const trailers: Record<string, string> = {};
      for (const line of opts.message.split('\n').slice(1)) {
        const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
        if (m) trailers[m[1]] = m[2];
      }
      commits.push({ domain, files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)), author: opts.author, trailers, subject });
      return { sha: 'f'.repeat(40), changed: true };
    },
  });
  __setLaunchDepsForTests({
    dagster: fakeDagster,
    head: async () => 'c'.repeat(40),
    now: () => new Date('2026-11-13T09:00:00.000Z'),
    sleep: async () => {},
  });
  __setMutationDepsForTests({
    // A warehouse connection (so the cursor rules are the generic ones), no Kubernetes, no Trino.
    platform: async () => 'snowflake',
    reconcile: async () => ({ ok: true, live: false, action: 'noop', name: 'data-sync-x', detail: 'test' }),
    queryFn: async () => ({ rows: [['0']] }),
  });
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  __setDataProjectGitForTests(null);
  __setLaunchDepsForTests(null);
  __setMutationDepsForTests(null);
});

/* ------------------------------------------------------------- normalisation -- */

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

function scrub(text: string): string {
  return text.replace(ISO, '<TS>').replace(/\bds_[a-z0-9_]+/g, '<ID>');
}

function normaliseCommits(): unknown {
  return commits.map((c) => ({
    domain: c.domain,
    author: c.author,
    // `via mcp:<tool>` vs `via ui:<route>` is the ONE deliberate difference.
    subject: scrub(c.subject.replace(/ — via .*$/, '')),
    'OS-Action': c.trailers['OS-Action'],
    'OS-Object': scrub(c.trailers['OS-Object'] ?? ''),
    'OS-Actor': c.trailers['OS-Actor'],
    files: c.files.map(([path, body]) => [scrub(path), scrub(body)]),
  }));
}

function normaliseLaunches(): unknown {
  return launches.map((l) => {
    const tags = { ...(l.tags ?? {}) };
    delete tags['os/surface'];
    return { jobName: l.jobName, domain: l.domain, selection: l.selection, tags: scrub(JSON.stringify(tags)), env: l.env };
  });
}

type Observed = { commits: unknown; launches: unknown };

async function observe(seed: () => void, run: () => Promise<unknown>): Promise<Observed> {
  store.__resetStore();
  commits = [];
  launches = [];
  seed();
  // The seed's own commits are not part of the comparison.
  await awaitDataProjectCommits();
  commits = [];
  await run();
  // A launch records its outcome on the version, which commits again — drain both, twice.
  await awaitDataProjectCommits();
  await awaitDataProjectLaunches();
  await awaitDataProjectCommits();
  return { commits: normaliseCommits(), launches: normaliseLaunches() };
}

async function mcp(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handleRpc(amir, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${tool}`);
  const result = (res as JsonRpcResponse).result as Record<string, unknown>;
  if (result.isError === true) {
    const err = (result.structuredContent as { error: ToolError }).error;
    assert.fail(`${tool} failed: ${err.code} — ${err.reason}`);
  }
  return result;
}

/* ------------------------------------------------------------------ the seeds -- */

function seedBronze(): void {
  store.__seedDatasetForTest({ id: BASE, name: 'Orders', owner: amir.id, domain: 'sales' });
  store.buildVersion(BASE, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
}

function seedSilver(): void {
  seedBronze();
  store.buildVersion(BASE, amir, 'silver', {
    quality: 'passing',
    artifact: 'silver/stg_orders.sql',
    body: 'create or replace table iceberg.personal_amir.silver_orders as select order_id, customer_id, net_amount from iceberg.personal_amir.bronze_orders',
    compiled: true,
  });
}

function seedSilverWithPartner(): void {
  seedSilver();
  store.__seedDatasetForTest({ id: PARTNER, name: 'Customers', owner: amir.id, domain: 'sales' });
  store.buildVersion(PARTNER, amir, 'bronze', { quality: 'passing', artifact: 'bronze/customers.dlt.yml' });
  store.buildVersion(PARTNER, amir, 'silver', {
    quality: 'passing',
    artifact: 'silver/stg_customers.sql',
    body: 'create or replace table iceberg.personal_amir.silver_customers as select customer_id, region from iceberg.personal_amir.bronze_customers',
    compiled: true,
  });
}

const SYNC = {
  connectionId: 'conn_wh',
  source: { schema: 'public', table: 'events' },
  mode: 'append' as const,
  cursor: { kind: 'timestamp' as const, column: 'updated_at' },
  schedule: { cron: '0 * * * *' },
  enabled: true,
};

function seedSynced(): void {
  seedSilver();
  store.setDatasetSync(BASE, amir, SYNC);
}

/**
 * A dataset with a BUILT Gold and documented columns — what `define_metric` needs (M8).
 *
 * The UI half is `store.defineMeasure` with the literal `Measure`, not `measureFromForm`: a
 * `tabs/data` test may not import `@tabs/metrics` (the tab-isolation rule), and the form →
 * `Measure` conversion has its own convergence tests in the Metrics tab. What is compared here is
 * exactly what must not drift — the committed tree, the author and the trailers.
 */
function seedGold(): void {
  seedSilver();
  store.setDocs(BASE, amir, {
    description: 'Orders',
    columns: [
      { name: 'order_id', description: 'key' },
      { name: 'order_date', description: 'when' },
      { name: 'net_amount', description: 'value' },
    ],
  });
  store.buildVersion(BASE, amir, 'gold', { quality: 'unknown', artifact: 'gold/mart_orders.sql', passThrough: true });
}

const REVENUE = { name: 'revenue', type: 'sum', sql: 'net_amount' } as const;

/* ------------------------------------------------------------- the 9 cases -- */

type Case = {
  tool: string;
  seed: () => void;
  mcpArgs: Record<string, unknown>;
  /** The UI route's half: the same service, the same input, inside a `ui:` surface scope. */
  ui: () => Promise<unknown>;
};

const CASES: Case[] = [
  {
    tool: 'create_dataset',
    seed: () => {},
    mcpArgs: { name: 'Orders', domain: 'sales', columns: [{ name: 'order_id', description: 'key' }] },
    ui: async () => createDatasetService(amir, { name: 'Orders', domain: 'sales', columns: [{ name: 'order_id', description: 'key' }] }),
  },
  {
    tool: 'add_dataset_version',
    seed: seedBronze,
    mcpArgs: { datasetId: BASE, layer: 'silver', passThrough: true },
    ui: async () => commitVersionService(amir, BASE, { layer: 'silver', passThrough: true }),
  },
  {
    tool: 'transform_silver',
    seed: seedBronze,
    mcpArgs: {
      datasetId: BASE,
      columns: ['order_id', 'customer_id', 'net_amount'],
      ops: [{ kind: 'cast', column: 'net_amount', type: 'double' }],
    },
    ui: async () =>
      transformSilverService(amir, BASE, {
        columns: ['order_id', 'customer_id', 'net_amount'],
        ops: [{ kind: 'cast', column: 'net_amount', type: 'double' }],
      }),
  },
  {
    tool: 'build_gold_join',
    seed: seedSilverWithPartner,
    mcpArgs: {
      datasetId: BASE,
      picks: [{ datasetId: PARTNER, type: 'left', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
      dimensions: [{ col: { ref: 1, column: 'region' } }],
      measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
    },
    ui: async () =>
      buildGoldJoinService(amir, BASE, {
        picks: [{ datasetId: PARTNER, type: 'left', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
        dimensions: [{ col: { ref: 1, column: 'region' } }],
        measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
      }),
  },
  {
    tool: 'define_quality_rules',
    seed: seedSilver,
    mcpArgs: { datasetId: BASE, rules: [{ rule: 'not_null', column: 'order_id' }] },
    ui: async () => defineQualityRulesService(amir, BASE, [{ rule: 'not_null', column: 'order_id' }]),
  },
  {
    tool: 'set_dataset_sync',
    seed: seedSilver,
    mcpArgs: {
      datasetId: BASE,
      connectionId: SYNC.connectionId,
      source: SYNC.source,
      mode: SYNC.mode,
      cursor: { column: 'updated_at', kind: 'timestamp' },
      schedule: 'hourly',
    },
    ui: async () => saveDatasetSyncService(amir, BASE, SYNC),
  },
  {
    tool: 'sync_dataset_now',
    seed: seedSynced,
    mcpArgs: { datasetId: BASE },
    ui: async () => syncDatasetNowService(amir, BASE, { reset: false }),
  },
  {
    tool: 'run_quality_checks',
    seed: seedSilver,
    mcpArgs: { datasetId: BASE },
    ui: async () => runQualityChecksService(amir, BASE),
  },
  {
    // Stream M (checklist M8): a metric definition is a commit in the domain's dbt project, and
    // both doors must produce the SAME `models/semantic/<model>.yml`.
    tool: 'define_metric',
    seed: seedGold,
    mcpArgs: { datasetId: BASE, name: 'revenue', aggregation: 'sum', column: 'net_amount' },
    ui: async () => store.defineMeasure(BASE, amir, { ...REVENUE }),
  },
  {
    // The 9th case (review M-1): CLEARING a sync. The UI route passes `null`; the MCP tool had no
    // way to express it at all, so a client could create and change a sync but never remove one.
    tool: 'set_dataset_sync',
    seed: seedSynced,
    mcpArgs: { datasetId: BASE, clear: true },
    ui: async () => saveDatasetSyncService(amir, BASE, null),
  },
];

for (const c of CASES) {
  const label = c.mcpArgs.clear === true ? `${c.tool} (clear)` : c.tool;
  test(`X8 parity: ${label} — the MCP tool and the UI service produce the same commit and the same Dagster launch`, async () => {
    const throughMcp = await observe(c.seed, () => mcp(c.tool, c.mcpArgs));
    const throughUi = await observe(c.seed, () => runWithSurface(`ui:data/${c.tool}`, c.ui));
    assert.deepEqual(throughMcp.commits, throughUi.commits, `${c.tool}: the committed tree/author/trailers differ`);
    assert.deepEqual(throughMcp.launches, throughUi.launches, `${c.tool}: the Dagster launch differs`);
  });
}

test('X8 parity: the surface IS the one difference — the MCP commit says `via mcp:<tool>`, the UI commit `via ui:<route>`', async () => {
  await observe(seedBronze, () => mcp('define_quality_rules', { datasetId: BASE, rules: [{ rule: 'not_null', column: 'order_id' }] }));
  const viaMcp = commits.map((c) => c.subject);
  await observe(seedBronze, () =>
    runWithSurface('ui:data/datasets/[id]/checks', () => Promise.resolve(defineQualityRulesService(amir, BASE, [{ rule: 'not_null', column: 'order_id' }]))),
  );
  const viaUi = commits.map((c) => c.subject);
  assert.ok(viaMcp.every((s) => s.includes('via mcp:define_quality_rules')), `MCP subjects: ${viaMcp.join(' | ')}`);
  assert.ok(viaUi.every((s) => s.includes('via ui:data/datasets/[id]/checks')), `UI subjects: ${viaUi.join(' | ')}`);
  assert.equal(viaMcp.length, viaUi.length);
});

/* ------------------------------------------------------------- error parity -- */

const outsider: CurrentUser = { id: 'zed', name: 'Zed', domains: ['ops'], role: 'creator' };

async function mcpError(tool: string, args: Record<string, unknown>, user: CurrentUser = amir): Promise<ToolError> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  const result = (res as JsonRpcResponse).result as Record<string, unknown>;
  assert.equal(result.isError, true, `${tool}: expected a typed tool error`);
  return (result.structuredContent as { error: ToolError }).error;
}

async function uiError(run: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await run();
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 400, message: (e as Error).message };
  }
  return assert.fail('expected the service to throw');
}

test('X8 parity: a dataset the caller cannot see refuses IDENTICALLY on both doors, and a missing id is 404', async () => {
  seedSilver();
  // An EXISTING but invisible dataset: the store's shipped gate is 403 (`canView`), not 404 — the
  // same on both doors. (The 404-for-everything no-leak reading would change `store.getDataset`
  // for every surface in the OS; recorded as a follow-up, not smuggled in here.)
  const viaMcp = await mcpError('transform_silver', { datasetId: BASE, columns: ['order_id'] }, outsider);
  const viaUi = await uiError(() => transformSilverService(outsider, BASE, { columns: ['order_id'] }));
  assert.equal(viaMcp.code, 'forbidden');
  assert.equal(viaUi.status, 403);
  assert.equal(viaMcp.reason, viaUi.message);

  // A dataset that does not exist at all is `not_found` / 404 on both doors.
  const missingMcp = await mcpError('transform_silver', { datasetId: 'ds_nope', columns: ['order_id'] });
  const missingUi = await uiError(() => transformSilverService(amir, 'ds_nope', { columns: ['order_id'] }));
  assert.equal(missingMcp.code, 'not_found');
  assert.equal(missingUi.status, 404);
  assert.equal(missingMcp.reason, missingUi.message);
});

test('X8 parity: a role gate is 403 on BOTH doors, with the same reason', async () => {
  store.__seedDatasetForTest({ id: BASE, name: 'Orders', owner: amir.id, domain: 'sales', tier: 'asset' });
  const viaMcp = await mcpError('build_gold_join', { datasetId: BASE, picks: [], rematerializeOnly: true });
  const viaUi = await uiError(() => import('@tabs/data/lib/mutations-server').then((m) => m.rematerializeDomainTableService(amir, BASE)));
  assert.equal(viaMcp.code, 'forbidden');
  assert.equal(viaUi.status, 403);
  assert.equal(viaMcp.reason, viaUi.message);
});

test('X8 parity: validation is 400 naming the field on BOTH doors', async () => {
  seedBronze();
  const viaMcp = await mcpError('define_quality_rules', { datasetId: BASE, rules: [{ rule: 'not_null' }] });
  const viaUi = await uiError(() => Promise.resolve(defineQualityRulesService(amir, BASE, [{ rule: 'not_null' }])));
  assert.equal(viaMcp.code, 'bad_request');
  assert.equal(viaUi.status, 400);
  assert.equal(viaMcp.reason, viaUi.message);
  assert.match(viaUi.message, /needs a column/);

  const unknown = await mcpError('define_quality_rules', { datasetId: BASE, rules: [{ rule: 'bogus', column: 'x' }] });
  const unknownUi = await uiError(() => Promise.resolve(defineQualityRulesService(amir, BASE, [{ rule: 'bogus', column: 'x' }])));
  assert.equal(unknown.code, 'bad_request');
  assert.equal(unknown.reason, unknownUi.message);
});

/* ------------------------- the three divergences B4-3 fixed, now PINNED (M-2) -- */

/**
 * The payload a door returned, whichever door it was. A successful MCP tool result carries its
 * JSON as `content[0].text` (there is no `structuredContent` on a success — that is the error
 * shape); a service returns the object itself.
 */
function payload(raw: unknown): Record<string, unknown> {
  const result = (raw as { result?: unknown }).result ?? raw;
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  if (Array.isArray(content) && typeof content[0]?.text === 'string') {
    return JSON.parse(content[0].text as string) as Record<string, unknown>;
  }
  return result as Record<string, unknown>;
}

const bea: CurrentUser = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' };

test('X8 pinned (B4-3a): a gold join reads a PERSONAL partner from `iceberg.personal_<owner>` on both doors', async () => {
  // The bug: MCP `build_gold_join` resolved the partner with `assetTarget(up)` while the route
  // used the owner-aware `reuseSourceFqn(up)`, so joining a personal-lane partner through the MCP
  // compiled a read of the DOMAIN schema — a table that does not exist for a My-tier dataset.
  // Deep-equality would catch a re-divergence only while both doors are wrong in different ways;
  // this pins the VALUE, so a regression that breaks both identically still fails.
  const args = {
    datasetId: BASE,
    picks: [{ datasetId: PARTNER, type: 'left', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
    dimensions: [{ col: { ref: 1, column: 'region' } }],
    measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
  };
  const viaMcp = await mcpPlan(seedSilverWithPartner, () => mcp('build_gold_join', args));
  const viaUi = await mcpPlan(seedSilverWithPartner, () =>
    runWithSurface('ui:data/datasets/[id]/gold-join', () => buildGoldJoinService(amir, BASE, args as never) as Promise<unknown>),
  );
  for (const [door, sql] of [['mcp', viaMcp], ['ui', viaUi]] as const) {
    assert.match(sql, /iceberg\.personal_amir\.silver_customers/, `${door}: the personal partner must be read from the owner's own schema`);
    assert.doesNotMatch(sql, /iceberg\.sales\.silver_customers/, `${door}: the governed domain copy does not exist for a My-tier partner`);
  }
});

/** The compiled SQL of the plan a door produced — read off the result, not the commit. */
async function mcpPlan(seed: () => void, run: () => Promise<unknown>): Promise<string> {
  store.__resetStore();
  commits = [];
  launches = [];
  seed();
  await awaitDataProjectCommits();
  const out = payload(await run()) as { sql?: string };
  await awaitDataProjectCommits();
  await awaitDataProjectLaunches();
  assert.ok(typeof out.sql === 'string' && out.sql.length > 0, 'the door returned no compiled SQL');
  return out.sql as string;
}

test('X8 pinned (B4-3b): a transform of a PROMOTED dataset refreshes the governed domain copy on both doors', async () => {
  // The bug: MCP `transform_silver` never refreshed the promoted domain copy, so a rebuild through
  // the MCP left dashboards on the prior snapshot with no "stale" report. `refreshed` is the
  // assertion, not just "both doors agree".
  const seedPromoted = () => {
    store.__seedDatasetForTest({ id: BASE, name: 'Orders', owner: bea.id, domain: 'sales', tier: 'asset' });
    store.buildVersion(BASE, bea, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  };
  const args = { datasetId: BASE, columns: ['order_id', 'customer_id'] };
  for (const [door, run] of [
    ['mcp', () => handleRpc(bea, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'transform_silver', arguments: args } })],
    ['ui', () => runWithSurface('ui:data/datasets/[id]/transform', () => transformSilverService(bea, BASE, { columns: ['order_id', 'customer_id'] }))],
  ] as const) {
    store.__resetStore();
    commits = [];
    seedPromoted();
    await awaitDataProjectCommits();
    const raw = await run();
    const dt = payload(raw).domainTable as { state?: string } | undefined;
    assert.equal(dt?.state, 'refreshed', `${door}: the promoted domain table must be re-materialised, not silently left stale`);
    await awaitDataProjectCommits();
    await awaitDataProjectLaunches();
  }
});

/* ------------------------------------ more refusals, identical on both doors (M-3) -- */

const kenji: CurrentUser = { id: 'kenji', name: 'Kenji', domains: ['sales'], role: 'creator' };
const faraway: CurrentUser = { id: 'fatima', name: 'Fatima', domains: ['finance'], role: 'creator' };

test('X8 parity (M-3): a DOMAIN MEMBER who is not the owner is refused identically on both doors', async () => {
  seedSilver();
  const before = JSON.stringify(store.getDataset(BASE, amir));
  // Kenji can SEE the dataset (same domain) but may not edit it: `canView` passes and the edit
  // scope refuses. A different gate from the invisible-dataset case above, and the one a
  // colleague actually hits.
  const viaMcp = await mcpError('transform_silver', { datasetId: BASE, columns: ['order_id'] }, kenji);
  const viaUi = await uiError(() => transformSilverService(kenji, BASE, { columns: ['order_id'] }));
  assert.equal(viaMcp.code, 'forbidden');
  assert.equal(viaUi.status, 403);
  assert.equal(viaMcp.reason, viaUi.message, 'the same sentence, so a client and the panel teach the same lesson');
  // And nothing was written: the record is byte-identical to what it was before the refusal.
  assert.equal(JSON.stringify(store.getDataset(BASE, amir)), before, 'a refusal writes nothing');
});

test('X8 parity (M-3): a CROSS-LANE join partner is refused identically on both doors', async () => {
  seedSilver();
  // A partner in another domain, owned by someone else: amir cannot see it, so the pick cannot
  // resolve. Both doors must say the same thing — the MCP resolves picks itself, which is exactly
  // where B4-3a's divergence lived.
  store.__seedDatasetForTest({ id: 'ds_crosslane', name: 'Ledger', owner: faraway.id, domain: 'finance' });
  store.buildVersion('ds_crosslane', faraway, 'silver', {
    quality: 'passing',
    artifact: 'silver/stg_ledger.sql',
    body: 'create or replace table iceberg.personal_fatima.silver_ledger as select customer_id from iceberg.personal_fatima.bronze_ledger',
    compiled: true,
  });
  const picks = [{ datasetId: 'ds_crosslane', type: 'left', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }];
  const viaMcp = await mcpError('build_gold_join', { datasetId: BASE, picks, measures: [{ name: 'n', agg: 'count', col: { ref: 0, column: 'order_id' } }] });
  const viaUi = await uiError(() =>
    buildGoldJoinService(amir, BASE, { picks, measures: [{ name: 'n', agg: 'count', col: { ref: 0, column: 'order_id' } }] } as never),
  );
  assert.equal(viaMcp.reason, viaUi.message, 'the refusal text is identical');
  assert.ok(['forbidden', 'not_found', 'bad_request'].includes(viaMcp.code), `unexpected code ${viaMcp.code}`);
  assert.equal(viaUi.status, viaMcp.code === 'forbidden' ? 403 : viaMcp.code === 'not_found' ? 404 : 400);
});
