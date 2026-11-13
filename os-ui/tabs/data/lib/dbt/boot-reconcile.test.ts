/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The boot reconcile commits what the hook could not see (engine rebuild B4)
 * USER STORY: As an operator flipping `DATA_PROJECT_GIT` on I want proof that every existing
 *             dataset gets its initial commit at the next boot, that a crash between a store write
 *             and its commit is repaired, that a boot which changes nothing commits nothing, and
 *             that one broken domain neither stops the others nor the boot.
 * ARCHITECTURE:
 *   - Drives the real `reconcileDataProjectsAtBoot` against the real store with an INJECTED
 *     committer (the in-memory git store) and an injected domain list, so no repository, no
 *     OpenSearch and no cluster are involved.
 *   - The pre-B2 CronJob stand-down (B4-review H-1) is driven with a FAKE k8s client: N synced
 *     datasets must produce exactly N DELETEs before the first commit, and a 403 must be logged
 *     rather than thrown.
 *   - The last two tests are the exception: they use the REAL `commitTree` against a mkdtemp
 *     repository, because the thing under test is the merge invariant between the data half and
 *     the agents half (Part D) — the reconcile is a WHOLE-TREE writer, so `agents/` survives it
 *     only while that subtree is reserved. `instrumentation.ts` therefore installs the agents
 *     commit hook (which calls `reserveSubtree('agents/')`) BEFORE running this reconcile.
 */
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import {
  parseTrailers,
  appendTrailers,
  COMMITTER,
  commitSubtree,
  commitTree,
  listTree,
  reserveSubtree,
  __clearReservedSubtrees,
  type CommitTreeOptions,
} from '@core/infra/git-store';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import { reconcileDataProjectsAtBoot, BOOT_REASON } from '@tabs/data/lib/dbt/boot-reconcile';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
/** The smallest sync the store accepts — enough to make the dataset "synced" for the stand-down. */
const SYNC = {
  connectionId: 'conn_wh',
  source: { schema: 'public', table: 'events' },
  mode: 'append' as const,
  cursor: { kind: 'timestamp' as const, column: 'updated_at' },
  schedule: { cron: '0 6 * * *' },
  enabled: true,
};
const fatima: Principal = { id: 'fatima', domains: ['finance'], role: 'builder' };

type Call = { domain: string; files: Map<string, string>; opts: CommitTreeOptions };
let calls: Call[] = [];
/** Tree hashes the fake repository already holds, by domain — so "changed" is a real comparison. */
let heads: Map<string, string>;

function hash(files: Map<string, string>): string {
  return JSON.stringify([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const committer = async (domain: string, files: Map<string, string>, opts: CommitTreeOptions) => {
  const next = hash(files);
  const changed = heads.get(domain) !== next;
  if (changed) {
    heads.set(domain, next);
    calls.push({ domain, files, opts });
  }
  return { sha: 'a'.repeat(40), changed };
};

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  __setDataProjectGitForTests(true);
  calls = [];
  heads = new Map();
});
afterEach(() => {
  __setDataProjectGitForTests(null);
});

/** A dataset with a COMPILED silver — the shape that becomes a dbt model (a bare bronze landing
 *  is neither a model nor a source, so it contributes no file of its own). */
function seedDataset(id: string, name: string, user: Principal, domain: string, slug: string): void {
  store.__seedDatasetForTest({ id, name, owner: user.id, domain });
  store.buildVersion(id, user, 'bronze', { quality: 'passing', artifact: `bronze/${slug}.dlt.yml` });
  store.buildVersion(id, user, 'silver', {
    quality: 'passing',
    artifact: `silver/stg_${slug}.sql`,
    body: `create or replace table iceberg.personal_${user.id}.silver_${slug} as select order_id from iceberg.personal_${user.id}.bronze_${slug}`,
    compiled: true,
  });
}

function seed(): void {
  // Two domains of pre-existing datasets, written with NO commit hook installed — exactly the
  // state of an install that ran with the flag off.
  seedDataset('ds_orders', 'Orders', amir, 'sales', 'orders');
  seedDataset('ds_ledger', 'Ledger', fatima, 'finance', 'ledger');
}

test('first boot with the flag on: every existing dataset gets its initial commit, as the platform principal', async () => {
  seed();
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  assert.equal(out.ran, true);
  assert.deepEqual(out.domains, ['finance', 'sales'], 'domains are examined in a deterministic order');
  assert.deepEqual(out.committed.map((c) => c.domain), ['finance', 'sales']);
  assert.equal(out.failed.length, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    // The author is the PLATFORM principal — no person performed this write.
    assert.deepEqual(call.opts.author, { name: COMMITTER.name, email: COMMITTER.email });
    // `commitTree` appends `opts.trailers` to the message; the in-memory committer stands in for it.
    const trailers = parseTrailers(appendTrailers(call.opts.message, call.opts.trailers ?? {}));
    assert.equal(trailers['OS-Reason'], BOOT_REASON, 'the history distinguishes a catch-up from an action');
    assert.equal(trailers['OS-Actor'], 'system');
    assert.equal(trailers['OS-Surface'], `system:${BOOT_REASON}`);
    assert.match(call.opts.message, /^data\((finance|sales)\): reconcile project (finance|sales) — via system:boot-reconcile/);
    assert.ok(call.files.has('dbt_project.yml'), 'the commit carries the whole generated project');
  }
});

test('a second boot that changed nothing commits nothing', async () => {
  seed();
  await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  calls = [];
  const again = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  assert.equal(calls.length, 0, 'the tree hash decides — an unchanged project is not re-committed');
  assert.deepEqual(again.committed, []);
  assert.deepEqual(again.failed, []);
});

test('the crash gap is repaired: a write whose commit never happened is committed at the next boot', async () => {
  seed();
  await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  calls = [];
  // The store write lands, the process dies before the hook's commit (no listener is installed).
  store.addCheck('ds_orders', amir, { name: 'not_null(order_id)', rule: 'not_null', column: 'order_id' });
  assert.equal(calls.length, 0, 'no listener is installed — the write produced no commit');
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  assert.deepEqual(out.committed.map((c) => c.domain), ['sales'], 'only the domain that moved is committed');
  assert.equal(calls.length, 1);
  const models = [...calls[0].files.keys()].filter((f) => f.endsWith('schema.yml') || f.endsWith('sources.yml'));
  assert.ok(models.length > 0, 'the recovered commit carries the rule it lost');
  assert.ok([...calls[0].files.values()].some((body) => body.includes('not_null')), 'the quality rule is in the tree as a dbt test');
});

test('one broken domain neither stops the others nor the boot', async () => {
  seed();
  const out = await reconcileDataProjectsAtBoot({
    hydrate: async () => {}, hydration: () => 'hydrated' as const,
    domains: async () => ['sales', 'finance'],
    committer: async (domain, files, opts) => {
      if (domain === 'finance') throw new Error('repository is locked');
      return committer(domain, files, opts);
    },
  });
  assert.deepEqual(out.committed.map((c) => c.domain), ['sales']);
  assert.deepEqual(out.failed, [{ domain: 'finance', error: 'repository is locked' }]);
});

test('with the flag off the reconcile does nothing and claims nothing', async () => {
  seed();
  __setDataProjectGitForTests(false);
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales'] });
  assert.deepEqual(out, { domains: [], committed: [], failed: [], ran: false, cronsStoodDown: [] });
  assert.equal(calls.length, 0);
});

test('a domain whose last dataset was deleted is reconciled too — discovery is the UNION', async () => {
  seed();
  await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  calls = [];
  store.deleteDataset('ds_ledger', fatima);
  // The domain no longer appears in the store, but its repository is still on disk — discovery is
  // the UNION, so the domain is still EXAMINED. Whether its models may be removed is not this
  // test's business: that is the destructive-delta guard's, asserted against a real repository in
  // the two tests below (review H-1 / B4-review H-5).
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales', 'finance'] });
  assert.ok(out.domains.includes('finance'), 'the domain is examined even with no dataset left');
  assert.deepEqual(out.committed.map((c) => c.domain), ['finance']);
  assert.ok(calls[0].files.has('dbt_project.yml'), 'a domain with no datasets still has a parseable project');
});

// --- B4-review H-1: the pre-B2 scheduler is stood down BEFORE the first commit ------------------

test('every dataset with a sync has its pre-B2 CronJob DELETED before the first commit (B4-review H-1)', async () => {
  seed();
  seedDataset('ds_visits', 'Visits', amir, 'sales', 'visits');
  for (const id of ['ds_orders', 'ds_ledger', 'ds_visits']) {
    store.setDatasetSync(id, id === 'ds_ledger' ? fatima : amir, SYNC);
  }
  const deletes: string[] = [];
  const order: string[] = [];
  const out = await reconcileDataProjectsAtBoot({
    hydrate: async () => {},
    hydration: () => 'hydrated' as const,
    domains: async () => ['sales', 'finance'],
    cron: async (datasetId) => {
      deletes.push(datasetId);
      order.push(`delete:${datasetId}`);
      return { ok: true, live: true, action: 'deleted' as const, name: `data-sync-${datasetId}`, detail: 'Deleted.' };
    },
    committer: async (domain, files, opts) => {
      order.push(`commit:${domain}`);
      return committer(domain, files, opts);
    },
  });
  assert.deepEqual(deletes.slice().sort(), ['ds_ledger', 'ds_orders', 'ds_visits'], 'N synced datasets ⇒ N deletes, one each');
  assert.ok(
    order.indexOf('commit:finance') > order.lastIndexOf('delete:ds_visits'),
    'every delete happens BEFORE the first commit of os/schedules.yml — otherwise a slice fires twice',
  );
  assert.deepEqual(
    out.cronsStoodDown.map((c) => c.removed),
    [true, true, true],
    'the result reports what was stood down',
  );
});

test('a 403 from a cluster with no `batch` grant is LOGGED, not thrown, and the reconcile still commits (B4-review H-1)', async () => {
  seed();
  store.setDatasetSync('ds_orders', amir, SYNC);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let out: Awaited<ReturnType<typeof reconcileDataProjectsAtBoot>>;
  try {
    out = await reconcileDataProjectsAtBoot({
      committer,
      hydrate: async () => {},
      hydration: () => 'hydrated' as const,
      domains: async () => ['sales', 'finance'],
      // The honest shape `removeSyncCronJob` returns for a refusal: ok false, live false.
      cron: async (datasetId) => ({ ok: false, live: false, action: 'noop' as const, name: `data-sync-${datasetId}`, detail: 'Kubernetes rejected the CronJob deletion (HTTP 403).' }),
    });
  } finally {
    console.error = realError;
  }
  assert.equal(out.ran, true, 'the boot carried on');
  assert.deepEqual(out.committed.map((c) => c.domain), ['finance', 'sales'], 'the projects were still committed');
  assert.deepEqual(out.cronsStoodDown, [{ datasetId: 'ds_orders', removed: false, detail: 'Kubernetes rejected the CronJob deletion (HTTP 403).' }]);
  assert.ok(errors.some((e) => e.includes('ds_orders') && e.includes('403')), 'the refusal is logged, loudly');
});

test('a cron client that THROWS cannot take the boot down (B4-review H-1)', async () => {
  seed();
  store.setDatasetSync('ds_orders', amir, SYNC);
  const realError = console.error;
  console.error = () => {};
  let out: Awaited<ReturnType<typeof reconcileDataProjectsAtBoot>>;
  try {
    out = await reconcileDataProjectsAtBoot({
      committer,
      hydrate: async () => {},
      hydration: () => 'hydrated' as const,
      domains: async () => ['sales'],
      cron: async () => { throw new Error('ECONNREFUSED'); },
    });
  } finally {
    console.error = realError;
  }
  assert.equal(out.ran, true);
  assert.deepEqual(out.cronsStoodDown, [{ datasetId: 'ds_orders', removed: false, detail: 'ECONNREFUSED' }]);
});

// --- the merge invariant with the agents half (Part D): a whole-tree reconcile must not delete
// `agents/`. Real repository, real `commitTree` (no injected committer).

const realRepos = mkdtempSync(join(tmpdir(), 'os-repos-boot-reconcile-'));
after(() => {
  __clearReservedSubtrees();
  rmSync(realRepos, { recursive: true, force: true });
});

const nadia: Principal = { id: 'nadia', domains: ['sales2'], role: 'creator' };
const AGENTS_PREFIX = 'agents/'; // `@tabs/agents/lib/git/generate` owns it; a data test may not import a tab

async function seedRepoWithBothHalves(domain: string): Promise<void> {
  await commitSubtree(
    domain,
    AGENTS_PREFIX,
    new Map([
      ['agents/index.yml', 'systems:\n  - slug: triage\n'],
      ['agents/triage/system.yaml', "version: '1'\n"],
    ]),
    { author: { name: 'Sovereign OS', email: 'os@sovereign.local' }, message: `agents(${domain}): create triage`, reposDir: realRepos },
  );
}

test('the data boot reconcile KEEPS a reserved `agents/` subtree in a domain that has both halves', async () => {
  __clearReservedSubtrees();
  seedDataset('ds_orders', 'Orders', amir, 'sales', 'orders');
  await seedRepoWithBothHalves('sales');
  // This is exactly what `installAgentProjectCommitHook` does at boot, before the reconcile runs.
  reserveSubtree(AGENTS_PREFIX);
  const out = await reconcileDataProjectsAtBoot({ hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales'], reposDir: realRepos });
  assert.deepEqual(out.committed.map((c) => c.domain), ['sales'], 'the dbt project was missing, so the tree moved');
  const paths = (await listTree('sales', 'main', { reposDir: realRepos })).map((e) => e.path);
  assert.ok(paths.includes('dbt_project.yml'), 'the data half is committed');
  assert.deepEqual(
    paths.filter((p) => p.startsWith(AGENTS_PREFIX)),
    ['agents/index.yml', 'agents/triage/system.yaml'],
    'the agents subtree survives a whole-tree reconcile untouched',
  );
});

test('without the reservation the same reconcile DELETES `agents/` — which is why the hook is installed first', async () => {
  __clearReservedSubtrees();
  seedDataset('ds_orders', 'Orders', nadia, 'sales2', 'orders');
  await seedRepoWithBothHalves('sales2');
  const out = await reconcileDataProjectsAtBoot({ hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales2'], reposDir: realRepos });
  assert.deepEqual(out.committed.map((c) => c.domain), ['sales2']);
  const paths = (await listTree('sales2', 'main', { reposDir: realRepos })).map((e) => e.path);
  assert.equal(paths.filter((p) => p.startsWith(AGENTS_PREFIX)).length, 0, 'the reservation is the ONLY thing that protects the subtree');
  // The destructive-delta guard does NOT cover this one, and must not be believed to: this
  // reconcile is WRITING a whole dbt project while it deletes, so it is a replacement, not an
  // empty read. The reservation (step 2 of `instrumentation.ts`'s ordered boot block) is the
  // protection here; the guard's case is the one below.
});

test('an EMPTY registry does not get the models deleted — the reconcile is refused (review H-1)', async () => {
  __clearReservedSubtrees();
  // A domain whose project was committed while its datasets were readable…
  // Enough datasets that the models outnumber the fixed project skeleton — the guard measures
  // the SHARE of the tree a reconcile would remove, so a domain with one dataset and eight
  // skeleton files is below the threshold by arithmetic (recorded as a deviation, not a surprise).
  for (const slug of ['orders', 'customers', 'invoices', 'shipments', 'returns', 'leads', 'quotes', 'refunds', 'visits', 'carts']) {
    seedDataset(`ds_${slug}`, slug, amir, 'sales3', slug);
  }
  const first = await reconcileDataProjectsAtBoot({ hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales3'], reposDir: realRepos });
  assert.deepEqual(first.committed.map((c) => c.domain), ['sales3']);
  const before = (await listTree('sales3', 'main', { reposDir: realRepos })).map((e) => e.path);
  assert.ok(before.filter((p) => p.startsWith('models/')).length > before.length / 2, 'the models are the bulk of the repo');

  // …and a LATER boot whose hydration said 'hydrated' but whose registry came back empty anyway
  // (the mirror answered, with nothing). The generated project is then the bare skeleton: it
  // deletes every model and adds not one path. Refused, loudly, with nothing committed.
  store.__resetStore();
  const second = await reconcileDataProjectsAtBoot({ hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['sales3'], reposDir: realRepos });
  assert.deepEqual(second.committed, [], 'nothing was committed');
  assert.deepEqual(second.failed.map((f) => f.domain), ['sales3']);
  assert.match(second.failed[0].error, /refusing a boot-reconcile commit/);
  assert.deepEqual((await listTree('sales3', 'main', { reposDir: realRepos })).map((e) => e.path), before, 'the project is byte-identical');
});

test('the boot reconcile does NOT run while the dataset registry is unverified (review H-1)', async () => {
  seedDataset('ds_orders', 'Orders', amir, 'sales', 'orders');
  for (const hydration of ['failed', 'pending'] as const) {
    const out = await reconcileDataProjectsAtBoot({ hydrate: async () => {}, hydration: () => hydration, committer, reposDir: '/nope' });
    assert.deepEqual(
      out,
      { domains: [], committed: [], failed: [], ran: false, cronsStoodDown: [] },
      `'${hydration}' examines nothing and claims nothing`,
    );
  }
  assert.deepEqual(calls, [], 'not one commit was attempted');
});

test('a hydrated registry with NO datasets may still empty a legacy repo — because the skeleton it writes is new (B4-review H-5)', async () => {
  __clearReservedSubtrees();
  // A repository from before the generator existed: three model files and no project skeleton.
  // Written as a PERSON, so the guard was never in play for this commit.
  await commitTree(
    'legacy',
    new Map([
      ['models/legacy/old_a.sql', 'select 1\n'],
      ['models/legacy/old_b.sql', 'select 2\n'],
      ['models/legacy/old_c.sql', 'select 3\n'],
    ]),
    { author: { name: 'Fatima', email: 'fatima@example.com' }, message: 'data(legacy): hand-written models', reposDir: realRepos },
  );
  // The store is hydrated and this domain genuinely owns nothing. The generated project deletes
  // all three files — 100%, far past the ratio — but it ADDS `dbt_project.yml`, `profiles.yml`,
  // the macros and the generic tests, so it is REPLACING a tree, not reading an empty registry.
  // The guard's second condition is what lets this through, and it must.
  const out = await reconcileDataProjectsAtBoot({ hydrate: async () => {}, hydration: () => 'hydrated' as const, domains: async () => ['legacy'], reposDir: realRepos });
  assert.deepEqual(out.failed, [], 'the guard did not fire — the commit creates paths of its own');
  assert.deepEqual(out.committed.map((c) => c.domain), ['legacy']);
  const paths = (await listTree('legacy', 'main', { reposDir: realRepos })).map((e) => e.path);
  assert.ok(paths.includes('dbt_project.yml') && paths.includes('profiles.yml'), 'the skeleton is there');
  assert.equal(paths.filter((p) => p.startsWith('models/legacy/old_')).length, 0, 'the hand-written models are gone, as asked');
});
