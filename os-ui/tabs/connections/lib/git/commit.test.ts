/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — the connection commit path and the read-back from git
 * USER STORY: As an operator I want what Trino loads to be what is committed: saving a warehouse
 *             connection commits its catalog file, and registering it reads the file BACK from
 *             git at a sha and applies exactly those bytes, recording the sha (contract C4).
 * ARCHITECTURE: node:test against the real module (and a real temp git repo where it commits); no mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, readBlob } from '@core/infra/git-store';
import { commitConnections, readCatalogFromGit, __setConnectionsGitForTests } from '@tabs/connections/lib/git/commit';
import type { SnapshotConnection } from '@tabs/connections/lib/git/generate';
import { applyLiveRegistration, type RegK8s } from '@tabs/connections/lib/warehouse/k8s-registration';

const ACTOR = { id: 'alex@example.com', name: 'Alex', email: 'alex@example.com' };

function pg(catalog = 'pg_sales'): SnapshotConnection {
  return {
    id: `conn_${catalog}`,
    name: 'Sales Postgres',
    template: 'warehouse',
    owner: ACTOR.id,
    domain: 'sales',
    visibility: 'domain',
    archived: false,
    secretRef: { name: `conn-${catalog}`, key: 'password' },
    warehouse: { platform: 'postgresql', catalog, config: { host: 'db.internal', database: 'sales', username: 'reader' } },
  };
}

test('a save commits connections/** as the actor; the catalog reads back from git at that sha', async () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'os-conn-git-'));
  __setConnectionsGitForTests(true);
  try {
    const res = await commitConnections('sales', ACTOR, { action: 'create connection', object: 'pg_sales' }, { reposDir, captured: [pg()], mirror: false });
    assert.ok(res?.changed);
    const [head] = await log('sales', { reposDir, limit: 1 });
    assert.equal(head.sha, res!.sha);
    assert.match(head.message, /^connections\(sales\): create connection pg_sales — via ui:connections/);
    assert.equal(head.author.email, ACTOR.email);

    const back = await readCatalogFromGit('sales', 'pg_sales', { reposDir });
    assert.equal(back.sha, res!.sha);
    assert.equal(back.text, await readBlob('sales', res!.sha, 'connections/pg_sales/catalog.properties', { reposDir }));
    assert.equal(back.props['connection-password'], '${ENV:POSTGRESQL_PASSWORD}');

    // Unchanged state → no new commit.
    const again = await commitConnections('sales', ACTOR, { action: 'update connection' }, { reposDir, captured: [pg()], mirror: false });
    assert.equal(again?.changed, false);

    // A delete removes the catalog folder in a new commit; the read-back then refuses.
    const del = await commitConnections('sales', ACTOR, { action: 'delete connection' }, { reposDir, captured: [], mirror: false });
    assert.ok(del?.changed);
    await assert.rejects(readCatalogFromGit('sales', 'pg_sales', { reposDir }), /not committed/);
  } finally {
    __setConnectionsGitForTests(null);
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('the live registration applies the committed bytes and records their sha on the ConfigMap', async () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'os-conn-git-'));
  __setConnectionsGitForTests(true);
  try {
    await commitConnections('sales', ACTOR, { action: 'create connection' }, { reposDir, captured: [pg()], mirror: false });
    const back = await readCatalogFromGit('sales', 'pg_sales', { reposDir });
    const calls: { method: string; path: string; body: any }[] = [];
    const k8s: RegK8s = async (method, path, body) => {
      calls.push({ method, path, body });
      return { status: 200, body: { spec: { template: { spec: { containers: [{ name: 'trino', env: [] }] } } } } };
    };
    const out = await applyLiveRegistration(
      { name: 'pg_sales', props: { 'connector.name': 'IGNORED-the-git-bytes-win' }, envVars: [], secretKeys: [], valuesSnippet: '' },
      {},
      { namespace: 'ns', k8s, committed: { text: back.text, sha: back.sha } },
    );
    assert.ok(out.ok, out.detail);
    const cm = calls.find((c) => c.path.endsWith('/configmaps/trino-catalog'))!;
    assert.equal(cm.body.data['pg_sales.properties'], back.text);
    assert.equal(cm.body.metadata.annotations['sovereign-os.io/connections-sha.pg_sales'], back.sha);
    assert.equal(out.source, 'git');
  } finally {
    __setConnectionsGitForTests(null);
    rmSync(reposDir, { recursive: true, force: true });
  }
});

test('NEGATIVE: with git off the writer commits nothing and says so (null), never pretends', async () => {
  __setConnectionsGitForTests(false);
  try {
    const res = await commitConnections('sales', ACTOR, { action: 'create connection' }, { captured: [pg()], mirror: false });
    assert.equal(res, null);
  } finally {
    __setConnectionsGitForTests(null);
  }
});
