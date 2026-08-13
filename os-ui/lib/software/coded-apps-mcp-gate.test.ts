/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * os-ui 0.6.133 — MCP PARITY for the coded-apps gate. When the platform admin has
 * coded apps OFF (the default), the Platform MCP must FAIL-CLOSED: creating a coded
 * app (create_software kind:'code') or committing raw code (commit) is rejected 403,
 * while Declarative authoring (create kind:'spec', set_app_spec/get_app_spec) stays
 * available. The harness enables coded apps process-wide; these tests drive it OFF
 * and restore it after, so sibling suites are unaffected.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { callPlatformMcp } from './platform-mcp.ts';
import type { App } from '@/lib/software/apps';
import { updateSettings } from '../platform-admin/settings.ts';

const builder: CurrentUser = { id: 'bg', name: 'Builder Gate', domains: ['sales'], role: 'builder' };

afterEach(() => { updateSettings({ codedAppsEnabled: true }); });

async function expectStatus(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status);
    return true;
  });
}

test('MCP coded OFF: create_software kind:"code" is rejected 403', async () => {
  updateSettings({ codedAppsEnabled: false });
  await expectStatus(
    callPlatformMcp(builder, 'create_software', { name: 'MCP Coded Off', kind: 'code', template: 'empty' }),
    403,
  );
});

test('MCP coded OFF: commit (raw code write) is rejected 403 even for a builder', async () => {
  updateSettings({ codedAppsEnabled: false });
  await expectStatus(
    callPlatformMcp(builder, 'commit', { appId: 'app_x', files: [{ path: 'a.txt', content: 'hi' }] }),
    403,
  );
});

test('MCP coded OFF: a DECLARATIVE (spec) app can still be created via create_software', async () => {
  updateSettings({ codedAppsEnabled: false });
  const app = (await callPlatformMcp(builder, 'create_software', { name: 'MCP Spec Off', kind: 'spec' })) as App;
  assert.ok(app.id);
  assert.equal(app.serveMode, 'spec');
});

test('MCP coded ON: commit reaches its normal validation (not the coded-off 403)', async () => {
  updateSettings({ codedAppsEnabled: true });
  const app = (await callPlatformMcp(builder, 'create_software', { name: 'MCP Coded On', kind: 'code', template: 'empty' })) as App;
  // With coded ON, commit passes the platform gate; an empty-files commit then trips
  // the tool's own 400 arg validation — proving the coded-off gate did NOT fire.
  await expectStatus(callPlatformMcp(builder, 'commit', { appId: app.id, files: [] }), 400);
});
