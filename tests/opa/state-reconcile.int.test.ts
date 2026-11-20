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
 *  Chart-seeded principals (`opa.governance.principals`, e.g. `test`/`sales` with clearance `pii`)
 *  keep their EXACT value through a reconcile and an OPA restart, and the run worker's policy
 *  gate (canary) reads not-ready while the state is lost and ready once it is restored.
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

// The OS stores' durable mirror is OpenSearch. This job has no OpenSearch, and the restore now
// (rightly) refuses to report governed tables "restored" from an UNREAD registry. A minimal,
// EMPTY OpenSearch REST fake gives every store a complete, empty read (index exists, 0 hits,
// all shards answered) and accepts writes — the subject under test here is OPA, not the mirror.
{
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    req.resume();
    req.on('end', () => {
      if (url.includes('/_count')) return send({ count: 0 });
      if (url.includes('/_search')) return send({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] } });
      return send({ result: 'ok', acknowledged: true });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  srv.unref();
  process.env.OPENSEARCH_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

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

async function waitHealthy(ms = 120_000): Promise<void> {
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
/** The chart's seeded principals, exactly as the chart's OPA loads them from governance.json. */
let SEED: Record<string, { domains: string[]; clearances: string[] }> = {};

async function assertSeedsExact(when: string): Promise<void> {
  const principals = (await data('governance/principals')) as Record<string, unknown>;
  for (const [id, p] of Object.entries(SEED)) {
    assert.deepEqual(principals[id], p, `${when}: chart-seeded principal ${id} kept exactly`);
  }
}
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
  // os-ui gets the chart's seed through OS_OPA_SEED_PRINCIPALS (_os-ui-env.tpl, the same values
  // block governance.json is rendered from). Read it from the freshly started chart OPA, BEFORE
  // the first import of the config.
  SEED = (await data('governance/principals')) as typeof SEED;
  assert.deepEqual(SEED.test?.clearances, ['pii'], 'precondition: the chart seeds test with pii');
  process.env.OS_OPA_SEED_PRINCIPALS = JSON.stringify(SEED);

  const { createUser } = await import('@tabs/admin/lib/users');
  await createUser({ id: 'leader-aw', email: 'leader-aw@example.com', password: 'S0me-Long-Passphrase!', domains: [RUNTIME_DOMAIN], role: 'creator' });
  const domains = await import('@tabs/admin/lib/domains');
  const { knownDomains } = await import('@tabs/admin/lib/users');
  await domains.ensureHydrated(knownDomains);
  domains.createDomain({ name: EMPTY_DOMAIN, owner: 'admin' });
  // Registered domains that are ALSO chart-seeded principals with a clearance: the restore writes
  // their self-principal and must not drop the seeded `pii`.
  for (const d of ['test', 'sales']) if (!domains.listDomains().some((x) => x.id === d)) domains.createDomain({ name: d, owner: 'admin' });

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
  const { policyStateReady } = await import('@tabs/agents/lib/build/run-jobs-server');
  assert.equal(await policyStateReady()(), false, 'the worker gate holds runs while the state is lost');
});

test('with the reconciler: an OPA restart is restored within one probe tick', async () => {
  const { startOpaReconciler, opaReconcileStatus, reconcileOpaState } = await import('@core/policy/opa-reconcile');
  stop = startOpaReconciler({ probeMs: PROBE_MS, periodMs: 60 * 60_000 });
  const boot = await reconcileOpaState('boot'); // joins the boot run started above
  assert.equal(boot.state, 'restored', boot.detail);
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), true);
  await assertSeedsExact('after the boot reconcile');
  const { policyStateReady } = await import('@tabs/agents/lib/build/run-jobs-server');
  assert.equal(await policyStateReady()(), true, 'the worker gate opens once the state is restored');

  const before = opaReconcileStatus().at ?? '';
  await restartOpa();
  const restartedAt = Date.now();
  // The restore that FOLLOWS this restart: a status newer than the boot run, written by the probe
  // (`opa-restart-detected`, or `retry` if its first attempt raced the container still stopping).
  const fresh = () => {
    const st = opaReconcileStatus();
    return st.state === 'restored' && (st.at ?? '') > before && ['opa-restart-detected', 'retry'].includes(st.reason ?? '');
  };
  const LIMIT = PROBE_MS + 8000; // one probe tick plus the restore's own writes, with CI slack
  await until(async () => fresh(), (v) => v, LIMIT);
  assert.ok(fresh(), `restored after the restart (status: ${JSON.stringify(opaReconcileStatus())})`);
  assert.ok(Date.now() - restartedAt < LIMIT, 'within one probe tick of the restart');
  assert.equal(await allow(RUNTIME_DOMAIN, 'query'), true, 'the runtime-domain decision is true again');

  const grants = (await data('grants')) as Record<string, string[]>;
  assert.ok(grants[`domain:${RUNTIME_DOMAIN}`]?.includes('query'), 'domain grant restored');
  assert.ok(grants[`domain:${EMPTY_DOMAIN}`]?.includes('query'), 'registered domain grant restored');
  assert.ok(grants['user:leader-aw'], 'user grant restored');
  assert.deepEqual(grants['os-sys-it'], ['query', 'search_knowledge'], 'agent-system grant restored');

  const principals = (await data('governance/principals')) as Record<string, { domains: string[] }>;
  assert.deepEqual(principals[RUNTIME_DOMAIN]?.domains, [RUNTIME_DOMAIN], 'runtime domain self-principal restored');
  assert.deepEqual(principals[EMPTY_DOMAIN]?.domains, [EMPTY_DOMAIN], 'empty registered domain self-principal restored');
  assert.deepEqual(principals['leader-aw']?.domains, [RUNTIME_DOMAIN], 'roster principal restored');
  await assertSeedsExact('after an OPA restart and the restore');
  // A second (periodic) reconcile must not erode them either.
  const again = await reconcileOpaState('periodic');
  assert.equal(again.state, 'restored', again.detail);
  await assertSeedsExact('after a periodic reconcile');
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
