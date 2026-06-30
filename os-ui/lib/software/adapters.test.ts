/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateAdapter, TEMPLATE_KEYS, FRONT_DOORS } from './adapters.ts';
import { authorThroughFrontDoor } from './server.ts';
import { authorizeConnectionCall } from '@/lib/agent-governed';

test('all 4 template adapters expose the 7 capabilities + a footprint', () => {
  assert.equal(TEMPLATE_KEYS.length, 4);
  for (const key of TEMPLATE_KEYS) {
    const a = templateAdapter(key);
    assert.equal(a.key, key);
    assert.ok(['web', 'service', 'script', 'dashboard'].includes(a.runtime));
    assert.ok(a.footprint.estMonthlyUsd > 0);
    for (const cap of ['scaffold', 'commit', 'preview', 'ciScan', 'deploy', 'autoMcp', 'capabilityToOpa']) {
      assert.equal(typeof (a as unknown as Record<string, unknown>)[cap], 'function', `${key} missing ${cap}`);
    }
    // scaffold seeds the metadata convention (app.yaml + openapi) so the auto-MCP works.
    const files = a.scaffold('Demo', 'demo');
    assert.equal(files.some((f) => f.path === 'app.yaml'), true);
    assert.equal(files.some((f) => f.path === 'openapi.yaml'), true);
  }
});

test('capabilityToOpa applies reads-on/writes-off and governs the principal', () => {
  const a = templateAdapter('nextjs-supabase');
  const tools = a.autoMcp('demo', [
    { name: 'list_x', description: '', write: false },
    { name: 'add_x', description: '', write: true },
  ]);
  assert.equal(tools.find((t) => t.name === 'list_x')!.mode, 'Read');
  assert.equal(tools.find((t) => t.name === 'add_x')!.mode, 'Write-approval');
  a.capabilityToOpa('app-demo-adapters', tools);
  assert.equal(authorizeConnectionCall('app-demo-adapters', 'list_x').effect, 'allow');
  assert.equal(authorizeConnectionCall('app-demo-adapters', 'add_x').effect, 'requires_approval');
});

test('the offline-mock pipeline backend reports mode and succeeds (dual pattern)', async () => {
  const a = templateAdapter('service');
  // Build a mock backend inline (server.ts picks live/mock by reachability).
  const mock = {
    mode: 'offline-mock' as const,
    scaffoldRepo: async () => ({ ok: true, mode: 'offline-mock' as const, detail: '' }),
    commit: async () => ({ ok: true, mode: 'offline-mock' as const, detail: 'committed' }),
    preview: async () => ({ step: { ok: true, mode: 'offline-mock' as const, detail: '' }, url: 'https://p' }),
    deploy: async () => ({ ok: true, mode: 'offline-mock' as const, detail: 'deployed' }),
  };
  const c = await a.commit(mock, 'svc', [{ path: 'a', content: 'b' }], 'm');
  assert.equal(c.mode, 'offline-mock');
  assert.equal(c.ok, true);
  const p = await a.preview(mock, 'svc');
  assert.ok(p.url);
});

test('all 4 front doors author + converge on the same metadata pipeline', async () => {
  assert.equal(FRONT_DOORS.length, 4);
  for (const door of ['chat', 'platform-mcp', 'git-push', 'git-import'] as const) {
    const r = await authorThroughFrontDoor(door, {
      name: 'Imported App',
      owner: 'zoe',
      description: 'x',
      files: door === 'git-import' ? undefined : [{ path: 'README.md', content: '# x\nhello\n' }],
      repoUrl: 'https://github.com/acme/app',
    });
    assert.equal(r.door, door);
    assert.ok(r.manifest.name);
    assert.ok(r.files.length > 0); // git-import derives a README when none given
  }
});
