/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppManifest, renderAppYaml, parseOpenApi, defaultOpenApi } from './metadata.ts';

test('app.yaml convention is parsed into the manifest (declared resources)', () => {
  const appYaml = renderAppYaml({
    name: 'Renewals Tracker',
    owner: 'alice',
    description: 'Track renewals',
    connections: ['salesforce'],
    data: ['accounts'],
    knowledge: ['discount-policy'],
  });
  const m = parseAppManifest(
    [
      { path: 'app.yaml', content: appYaml },
      { path: 'openapi.yaml', content: defaultOpenApi('renewals') },
      { path: '.app/decisions.md', content: '# decisions' },
    ],
    { name: 'fallback', owner: 'fallback' },
  );
  assert.equal(m.name, 'Renewals Tracker');
  assert.equal(m.owner, 'alice');
  assert.deepEqual(m.connections, ['salesforce']);
  assert.deepEqual(m.knowledge, ['discount-policy']);
  assert.equal(m.hasOpenApi, true);
  assert.equal(m.missing.length, 0);
});

test('imported/legacy repo (no app.yaml) derives what it can + flags the rest', () => {
  const m = parseAppManifest(
    [{ path: 'README.md', content: '# Orders API\nA legacy orders service.\n' }],
    { name: 'orders-api', owner: 'bob' },
  );
  assert.equal(m.name, 'orders-api');
  assert.equal(m.description.includes('legacy orders service'), true);
  assert.equal(m.missing.includes('app.yaml'), true);
  assert.equal(m.hasOpenApi, false);
  assert.equal(m.missing.some((x) => x.startsWith('openapi')), true);
});

test('parseOpenApi reads a committed spec', () => {
  const spec = parseOpenApi([{ path: 'openapi.yaml', content: defaultOpenApi('x') }]);
  assert.ok(spec);
  assert.ok(spec!.paths['/renewals']);
});
