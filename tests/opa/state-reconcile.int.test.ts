/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * state-reconcile.int.test — against the REAL OPA container started from the chart
 * (tests/opa/run-chart-opa.py, CI job `test-opa`; image openpolicyagent/opa:1.22.4).
 *
 * The incident it pins: an OPA restart lost every REST-pushed document, so OPA had no
 * `data.grants`, only the chart-seeded domain principals, and
 * `agentic/authz/allow {principal:"<runtime domain>", tool:"query"}` was false.
 *
 *  1. Negative twin: state seeded through the OS, OPA restarted, NO reconciler → stays false.
 *  2. With the reconciler (the shipped wiring, `opa-state-sources.ts`): restart OPA → within one
 *     probe tick grants and every domain principal are back and the decision is true again.
 *  3. Negative twin: OPA unreachable → status "not-restored" and the Monitoring alert
 *     "Policy state not restored"; OPA back → restored.
 *
 * Run: OPA_IT_URL=http://127.0.0.1:18181 OPA_IT_CONTAINER=opa-it \
 *   node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/state-reconcile.int.test.ts
 * (from os-ui/).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const OPA = process.env.OPA_IT_URL;
const CONTAINER = process.env.OPA_IT_CONTAINER;
if (!OPA || !CONTAINER) {
  throw new Error('state-reconcile.int.test needs OPA_IT_URL and OPA_IT_CONTAINER (a real OPA container)');
}
process.env.OPA_URL = OPA;

const RUNTIME_DOMAIN = 'agentic-leader-autumn-winter-2026-2027';
const EMPTY_DOMAIN = 'kiekert'; // registered in the domain registry, no users and no datasets
const PROBE_MS = 500;

function docker(...args: string[]): void {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${OPA}/health`)).ok;
  } catch {
    return false;
  }
}

async function waitHealthy(ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await healthy())) {
    if (Date.now() > until) throw new Error('OPA did not become healthy');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function restartOpa(): Promise<void> {
  docker('restart', '-t', '1', CONTAINER!);
  await waitHealthy();
}

async function allow(principal: string, tool: string): Promise<boolean> {
  const res = await fetch(`${OPA}/v1/data/agentic/authz/allow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { principal, tool } }),
  });
  assert.ok(res.ok, `OPA decision ${res.status}`);
  return ((await res.json()) as { result?: boolean }).result === true;
}

async function data(path: string): Promise<unknown> {
  const body = (await (await fetch(`${OPA}/v1/data/${path}`)).json()) as { result?: unknown };
  return body.result;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let stop: (() => void) | undefined;
after(() => {
  stop?.();
  // Leave the container running for the job's later steps and log dump.
  if (!spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER!], { encoding: 'utf8' }).stdout.includes('true')) {
    docker('start', CONTAINER!);
  }
});

test('seed through the OS: a runtime-domain user, a registered empty domain, an agent-system grant', async () => {
  await restartOpa(); // start from the chart's files only
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), false, 'precondition: not chart-seeded');

  const { createUser } = await import('@tabs/admin/lib/users');
  await createUser({ id: 'leader-aw', email: 'leader-aw@example.com', password: 'S0me-Long-Passphrase!', domains: [RUNTIME_DOMAIN], role: 'creator' });
  const domains = await import('@tabs/admin/lib/domains');
  const { knownDomains } = await import('@tabs/admin/lib/users');
  await domains.ensureHydrated(knownDomains);
  domains.createDomain({ name: EMPTY_DOMAIN, owner: 'admin' });

  const { registerOpaStateSources } = await import('../../os-ui/opa-state-sources.ts');
  registerOpaStateSources();
  // A built agent system's grant, contributed the way the agents tab contributes it.
  const { registerGrantContributor } = await import('@core/policy/opa-reconcile');
  registerGrantContributor({ name: 'test-agent-system', grants: async () => ({ 'os-sys-it': ['query', 'search_knowledge'] }) });

  // The OS's own change path (Platform Admin recompile) publishes the grants.
  const { recompile } = await import('../../os-ui/app/api/platform-admin/_compile.ts');
  const { publish } = await recompile();
  assert.equal(publish.status, 'published', publish.detail);
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), true, 'the recompile grants the runtime domain');
  assert.equal(await allow('os-sys-it', 'search_knowledge'), true, 'a whole-document recompile keeps agent-system grants');
});

test('negative twin: with the reconciler disabled the decision stays false after an OPA restart', async () => {
  await restartOpa();
  assert.equal(await data('grants'), undefined, 'OPA lost data.grants on restart');
  await new Promise((r) => setTimeout(r, PROBE_MS * 3)); // well past a probe tick
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), false);
});

test('with the reconciler: an OPA restart is restored within one probe tick', async () => {
  const { startOpaReconciler, opaReconcileStatus, reconcileOpaState } = await import('@core/policy/opa-reconcile');
  stop = startOpaReconciler({ probeMs: PROBE_MS, periodMs: 60 * 60_000 });
  const boot = await reconcileOpaState('boot'); // joins the boot run started above
  assert.equal(boot.state, 'restored', boot.detail);
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), true);

  await restartOpa();
  const restoredAfter = Date.now();
  // One probe tick (PROBE_MS) plus the restore's own writes.
  const ok = await until(() => allow(RUNTIME_DOMAIN, 'query'), (v) => v, PROBE_MS + 4000);
  assert.equal(ok, true, `decision restored (status: ${JSON.stringify(opaReconcileStatus())})`);
  assert.ok(Date.now() - restoredAfter < PROBE_MS + 4000);
  assert.equal(opaReconcileStatus().state, 'restored');
  assert.equal(opaReconcileStatus().reason, 'opa-restart-detected');

  const grants = (await data('grants')) as Record<string, string[]>;
  assert.ok(grants[`domain:${RUNTIME_DOMAIN}`]?.includes('query'), 'domain grant restored');
  assert.ok(grants[`domain:${EMPTY_DOMAIN}`]?.includes('query'), 'registered domain grant restored');
  assert.ok(grants['user:leader-aw'], 'user grant restored');
  assert.deepEqual(grants['os-sys-it'], ['query', 'search_knowledge'], 'agent-system grant restored');

  const principals = (await data('governance/principals')) as Record<string, { domains: string[] }>;
  assert.deepEqual(principals[RUNTIME_DOMAIN]?.domains, [RUNTIME_DOMAIN], 'runtime domain self-principal restored');
  assert.deepEqual(principals[EMPTY_DOMAIN]?.domains, [EMPTY_DOMAIN], 'empty registered domain self-principal restored');
  assert.deepEqual(principals['leader-aw']?.domains, [RUNTIME_DOMAIN], 'roster principal restored');
  for (const seeded of ['agentic-leader-q3-2026', 'sales', 'test']) {
    assert.ok(principals[seeded], `chart-seeded principal ${seeded} untouched`);
  }
});

test('negative twin: an unreachable OPA surfaces "Policy state not restored", then recovers', async () => {
  const { probeOpaState, opaReconcileStatus } = await import('@core/policy/opa-reconcile');
  const { deriveAlerts } = await import('@tabs/monitoring/lib/alerts-derive');
  docker('stop', '-t', '1', CONTAINER!);
  assert.equal(await probeOpaState(), 'unreachable');
  const st = opaReconcileStatus();
  assert.equal(st.state, 'not-restored');
  const admin = { level: 'admin', principal: 'admin', domains: [], cluster: true, via: 'identity' } as const;
  const alerts = deriveAlerts([], [], admin, st);
  assert.ok(alerts.some((a) => a.title === 'Policy state not restored'), 'Monitoring shows the alert');
  const user = { level: 'user', principal: 'leader-aw', domains: [RUNTIME_DOMAIN], cluster: false, via: 'identity' } as const;
  assert.equal(deriveAlerts([], [], user, st).length, 0, 'cluster-wide alert is admin-only');

  docker('start', CONTAINER!);
  await waitHealthy();
  const back = await until(async () => opaReconcileStatus().state, (s) => s === 'restored', PROBE_MS + 5000);
  assert.equal(back, 'restored');
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), true);
});
