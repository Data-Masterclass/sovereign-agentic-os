/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Generated README tests — deterministic, per existing folder, writer READMEs kept
 * USER STORY: As an engineer I want every folder of a cloned repo to explain itself, and as a
 *             maintainer I want proof that regeneration never makes a commit by itself and never
 *             overwrites a README its writer owns.
 * ARCHITECTURE:
 *   - The pure generator, then the git store's commit path over a temp repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatedReadmes, GENERATED_MARK, isGeneratedReadme } from '@core/infra/repo-readme';
import { commitTree, readBlob, listTree } from '@core/infra/git-store';
import { layoutMarker, LAYOUT_MARKER_PATH, userRepoName } from '@core/infra/repo-layout';

const tree = ['data/dbt/dbt_project.yml', 'agents/triage/system.yaml', 'dashboards/sales/chart.vl.json', LAYOUT_MARKER_PATH];

test('one README for the root, each present top-level folder and each artifact folder; deterministic', () => {
  const a = generatedReadmes(tree, 'domain-sales');
  assert.deepEqual([...a.keys()], [
    'README.md', 'agents/README.md', 'agents/triage/README.md', 'dashboards/README.md', 'dashboards/sales/README.md',
    'data/README.md', 'data/dbt/README.md', 'os/README.md',
  ]);
  assert.deepEqual([...generatedReadmes([...tree].reverse(), 'domain-sales')], [...a], 'order-independent, byte-identical');
  for (const c of a.values()) {
    assert.ok(c.startsWith(GENERATED_MARK));
    assert.match(c, /## Run it without the OS/);
    assert.match(c, /## Upstream docs\n\n- https:\/\//);
    assert.match(c, /Owner: the `sales` domain/);
  }
  assert.match(a.get('data/dbt/README.md')!, /cd data\/dbt && dbt parse/);
  assert.match(a.get('agents/triage/README.md')!, /node agents\/triage\/run\.mjs/);
  assert.ok(!a.has('apps/README.md'), 'no README for a folder that does not exist');
  assert.doesNotMatch(a.get('data/README.md')!, /dagster/, 'no Dagster command without data/dagster/');
  const withDagster = generatedReadmes([...tree, 'data/dagster/definitions.py'], 'domain-sales');
  assert.match(withDagster.get('data/README.md')!, /dagster dev -f data\/dagster\/definitions\.py/);
  assert.ok(withDagster.has('data/dagster/README.md'));
  assert.match(generatedReadmes(tree, userRepoName('a@b.c')).get('README.md')!, /Only they and the platform admins/);
});

test('in a commit: READMEs appear in a v2 tree only, a writer README is kept, a re-commit is a no-op', async () => {
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-readme-'));
  const author = { name: 'T', email: 't@t' };
  const v1 = await commitTree('one', new Map([['dbt_project.yml', 'x\n']]), { author, message: 'v1', reposDir });
  assert.deepEqual((await listTree('one', v1.sha, { reposDir })).map((e) => e.path), ['dbt_project.yml'], 'a v1 tree is left exactly as passed');
  const files = new Map([
    [LAYOUT_MARKER_PATH, layoutMarker()],
    ['data/dbt/dbt_project.yml', 'x\n'],
    ['data/dbt/README.md', '# the dbt project, as its generator writes it\n'],
  ]);
  const c1 = await commitTree('two', files, { author, message: 'v2', reposDir });
  assert.equal(await readBlob('two', c1.sha, 'data/dbt/README.md', { reposDir }), '# the dbt project, as its generator writes it\n');
  assert.ok(isGeneratedReadme(await readBlob('two', c1.sha, 'README.md', { reposDir })));
  assert.ok(isGeneratedReadme(await readBlob('two', c1.sha, 'data/README.md', { reposDir })));
  const c2 = await commitTree('two', files, { author, message: 'again', reposDir });
  assert.equal(c2.changed, false, 'regenerating the READMEs never makes a commit by itself');
});
