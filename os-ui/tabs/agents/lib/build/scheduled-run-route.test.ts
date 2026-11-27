/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The scheduled-run receiver decides from the system read FRESH from the mirror
 * USER STORY: As the owner, when I archive my agent system or clear / change its schedule, a
 *             CronJob that is still around (left by an older pod, or resurrected by a resync that
 *             read a stale registry) must not run my agent against my choice — while the chart's
 *             static schedules keep working.
 * ARCHITECTURE:
 *   - `scheduledRunGate` (pure) is the whole decision; the REAL route is driven with the fresh
 *     mirror read, the bearer check, the pin and the run door mocked at the module seam, and
 *     `runScheduledSystem` records whether a run was started — the effect a refusal must prevent.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// The real gate, imported BEFORE the module is mocked for the route.
const { scheduledRunGate } = await import('@tabs/agents/lib/build/scheduled');

type Fresh = Parameters<typeof scheduledRunGate>[0];
let FRESH: Fresh = { state: 'unreachable' };
let started: string[] = [];

mock.module('@tabs/agents/lib/store', {
  namedExports: {
    readScheduleFresh: async () => FRESH,
    systemForScheduler: () => ({ yaml: 'y', domain: 'sales', owner: 'amir', disabledAgents: [], archived: false }),
    recordActivity: () => {},
  },
});
mock.module('@tabs/agents/lib/build/runtime-auth', { namedExports: { runtimeTokenOk: () => true } });
mock.module('@tabs/agents/lib/lifecycle-adapter', { namedExports: { scheduledSystemYaml: async () => ({ ok: true, yaml: 'pinned' }) } });
mock.module('@tabs/agents/lib/build/scheduled', {
  namedExports: {
    scheduledRunGate,
    runScheduledSystem: async (id: string) => {
      started.push(id);
      return { ok: true, report: { runId: 'r1' } };
    },
  },
});

const { POST } = await import('../../../../app/api/agents/scheduled-run/route.ts');

function fire(headers: Record<string, string> = {}) {
  return POST(new Request('http://os-ui:3000/api/agents/scheduled-run', {
    method: 'POST',
    headers: { authorization: 'Bearer x', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ systemId: 'sys_a' }),
  }));
}
const OS_UI = (cron: string) => ({ 'X-Schedule-Source': 'os-ui', 'X-Schedule-Cron': cron });
const found = (schedule: { kind: string; cron?: string }, archived = false): Fresh => ({ state: 'found', system: { id: 'sys_a', schedule, archived } });

beforeEach(() => {
  started = [];
});

test('an os-ui CronJob whose cron IS the stored schedule runs', async () => {
  FRESH = found({ kind: 'cron', cron: '0 8 * * *' });
  const res = await fire(OS_UI('0 8 * * *'));
  assert.equal(res.status, 200);
  assert.deepEqual(started, ['sys_a']);
});

test('REFUSED 409: the system is archived (whatever fired)', async () => {
  FRESH = found({ kind: 'cron', cron: '0 8 * * *' }, true);
  for (const headers of [OS_UI('0 8 * * *'), {}]) {
    const res = await fire(headers);
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /archived/);
  }
  assert.deepEqual(started, []);
});

test('REFUSED 409: an os-ui CronJob whose schedule was cleared (manual) or edited', async () => {
  FRESH = found({ kind: 'manual' });
  let res = await fire(OS_UI('0 8 * * *'));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /no longer on a cron schedule/);
  FRESH = found({ kind: 'cron', cron: '0 9 * * 1' });
  res = await fire(OS_UI('0 8 * * *'));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /is not the stored schedule "0 9 \* \* 1"/);
  assert.deepEqual(started, []);
});

test('the chart’s static schedule (no marker) still runs although the system has no cron of its own', async () => {
  FRESH = found({ kind: 'manual' });
  const res = await fire({});
  assert.equal(res.status, 200);
  assert.deepEqual(started, ['sys_a']);
});

test('REFUSED 503: the mirror cannot be read — never a run on a guess', async () => {
  FRESH = { state: 'unreachable' };
  const res = await fire(OS_UI('0 8 * * *'));
  assert.equal(res.status, 503);
  assert.deepEqual(started, []);
});

test('the manifest os-ui provisions sends the marker with its own cron', async () => {
  const { buildCronJobManifest } = await import('@tabs/agents/lib/schedule-cron');
  const m = buildCronJobManifest('sys_a', '0 8 * * *', { namespace: 'n', targetUrl: 'u', image: 'i', tokenSecret: 's', tokenSecretKey: 'k' }) as any;
  const c = m.spec.jobTemplate.spec.template.spec.containers[0];
  assert.equal(c.env.find((e: any) => e.name === 'SCHEDULE_CRON').value, '0 8 * * *');
  // Shell-free argv (the bundler once mangled the shell string): each header is its own element.
  assert.ok(c.command.includes('X-Schedule-Source: os-ui'));
  assert.ok(c.command.includes('X-Schedule-Cron: $(SCHEDULE_CRON)'));
});
