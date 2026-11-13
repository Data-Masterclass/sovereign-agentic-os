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
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { parseTrailers, appendTrailers, COMMITTER, type CommitTreeOptions } from '@core/infra/git-store';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import { reconcileDataProjectsAtBoot, BOOT_REASON } from '@tabs/data/lib/dbt/boot-reconcile';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
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
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
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
  await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
  calls = [];
  const again = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
  assert.equal(calls.length, 0, 'the tree hash decides — an unchanged project is not re-committed');
  assert.deepEqual(again.committed, []);
  assert.deepEqual(again.failed, []);
});

test('the crash gap is repaired: a write whose commit never happened is committed at the next boot', async () => {
  seed();
  await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
  calls = [];
  // The store write lands, the process dies before the hook's commit (no listener is installed).
  store.addCheck('ds_orders', amir, { name: 'not_null(order_id)', rule: 'not_null', column: 'order_id' });
  assert.equal(calls.length, 0, 'no listener is installed — the write produced no commit');
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
  assert.deepEqual(out.committed.map((c) => c.domain), ['sales'], 'only the domain that moved is committed');
  assert.equal(calls.length, 1);
  const models = [...calls[0].files.keys()].filter((f) => f.endsWith('schema.yml') || f.endsWith('sources.yml'));
  assert.ok(models.length > 0, 'the recovered commit carries the rule it lost');
  assert.ok([...calls[0].files.values()].some((body) => body.includes('not_null')), 'the quality rule is in the tree as a dbt test');
});

test('one broken domain neither stops the others nor the boot', async () => {
  seed();
  const out = await reconcileDataProjectsAtBoot({
    hydrate: async () => {},
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
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales'] });
  assert.deepEqual(out, { domains: [], committed: [], failed: [], ran: false });
  assert.equal(calls.length, 0);
});

test('a domain whose last dataset was deleted is reconciled too (the repository is emptied)', async () => {
  seed();
  await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
  calls = [];
  store.deleteDataset('ds_ledger', fatima);
  // The domain no longer appears in the store, but its repository is still on disk — discovery is
  // the UNION, so the empty project is committed.
  const out = await reconcileDataProjectsAtBoot({ committer, hydrate: async () => {}, domains: async () => ['sales', 'finance'] });
  assert.deepEqual(out.committed.map((c) => c.domain), ['finance']);
  assert.ok(calls[0].files.has('dbt_project.yml'), 'a domain with no datasets still has a parseable project');
});
