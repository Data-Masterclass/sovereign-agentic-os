/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    MCP = UI for every data mutation (engine rebuild B4, checklist X8)
 * USER STORY: As a data engineer I want proof that driving the OS MCP and driving the Data tab
 *             produce the SAME repo commit (same files, same author, same OS-Actor trailer) and the
 *             SAME Dagster launch for the same input — so neither door can drift from the other.
 * ARCHITECTURE:
 *   - ONE table-driven test over the eight mutating data tools. For each, the MCP handler is driven
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

/* -------------------------------------------------------------- the 8 tools -- */

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
];

for (const c of CASES) {
  test(`X8 parity: ${c.tool} — the MCP tool and the UI service produce the same commit and the same Dagster launch`, async () => {
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
