/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-g journey-g-agent-triggers.e2e — an agent system started by API and by its schedule
 * USER STORY: As the owner I want proof, after every dev deploy, that an agent system can be run by
 *             an external caller (the OS MCP `run_agent_system`, the documented API door) and that
 *             a saved cron schedule really fires through Kubernetes and completes a run — the two
 *             unattended paths nobody clicks, so nothing else would notice them break.
 * ARCHITECTURE:
 *   - One synthetic probe system, `e2e-schedule-api-probe-<stamp>`, blank template, no grants (no
 *     tool, so no external write), instructions that only ask for a fixed reply.
 *   - Identity: a dedicated synthetic probe user on the cluster, signed in through the same
 *     `POST /api/auth/login` the browser uses (E2E_PROBE_USER / E2E_PROBE_PASSWORD; dev.yml reads
 *     them, masked, from the optional Secret `e2e-probe-credentials`). Its MCP bearer comes from
 *     `GET /api/mcp/token` — "My MCP access" — exactly what an external client is given.
 *     Without the credential the journey is SKIPPED with that reason (skipped.jsonl), never run
 *     to a meaningless red; with it, every assertion is an ordinary assertion (no expected-fail
 *     marker), so a regression fails the dev run.
 *   - Records read beside the OS's own answers: `run_jobs` / `run_events` in the `agent_runs`
 *     database (status, `input->>'trigger'`, the `done` frame) and Kubernetes' CronJob + Job
 *     objects (the CronJob os-ui provisioned, the Job the CronJob CONTROLLER created — the real
 *     scheduler, not a Job the harness made).
 *   - The real scheduler path: the schedule is `* * * * *`, so the CronJob controller fires
 *     within a minute; the schedule is cleared as soon as one run completed. Cleanup (clear the
 *     schedule, archive the probe) runs in `after()` whatever the assertions said.
 *   - Needs scheduled runs switched ON (Admin → Platform Settings → autonomous agents): with them
 *     off the scheduled run is refused 403 by design, and g2.* is red naming that refusal.
 */
import { after } from 'node:test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { journey, check } from '../lib/journey.mjs';
import { waitFor } from '../lib/common.mjs';
import { baseUrl } from '../lib/endpoints.mjs';
import { getJson, NS } from '../lib/kube.mjs';
import * as pg from '../lib/records/postgres.mjs';
import { HopError } from '../lib/hop.mjs';

const J = journey('AT-g', 'journey-g-agent-triggers');
const PROBE_USER = process.env.E2E_PROBE_USER ?? '';
const PROBE_PASSWORD = process.env.E2E_PROBE_PASSWORD ?? '';
const RUNS_DB = process.env.E2E_AGENT_RUNS_DB ?? 'agent_runs';
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const PROBE_NAME = `e2e-schedule-api-probe-${STAMP}`;
const REPLY = 'PROBE-OK';
const SESSION_COOKIES = ['__Host-soa_session', 'soa_session_insecure'];

// ------------------------------------------------------------------ the OS, as the probe user

let session; // { cookie, token, origin, base }

async function osBase() {
  return baseUrl('osUi');
}

/** Sign in once (the browser's door) and fetch the user's own MCP bearer (My MCP access). */
async function signIn() {
  if (session) return session;
  const base = await osBase();
  const origin = new URL(process.env.E2E_OS_PUBLIC_URL || base).origin;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASSWORD }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => { throw new HopError({ component: 'os-ui', hop: 'POST /api/auth/login', reason: `unreachable: ${e.message}` }); });
  if (!res.ok) throw new HopError({ component: 'os-ui', hop: 'POST /api/auth/login', reason: `HTTP ${res.status} for the probe user` });
  const sc = (res.headers.getSetCookie?.() ?? []).find((c) => SESSION_COOKIES.some((n) => c.startsWith(`${n}=`)));
  if (!sc) throw new HopError({ component: 'os-ui', hop: 'POST /api/auth/login', reason: 'no session cookie returned' });
  const cookie = sc.split(';')[0];
  const t = await fetch(`${base}/api/mcp/token`, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
  const body = await t.json().catch(() => ({}));
  if (!t.ok || !body.token) throw new HopError({ component: 'os-ui', hop: 'GET /api/mcp/token', reason: `HTTP ${t.status}: no MCP bearer` });
  // In GitHub Actions, mask both credentials before anything could echo them (a HopError detail,
  // a debug line): the bearer is long-lived and the cookie is a live session.
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::add-mask::${body.token}`);
    console.log(`::add-mask::${cookie.slice(cookie.indexOf('=') + 1)}`);
  }
  session = { cookie, token: body.token, origin, base };
  return session;
}

/** A cookie-session call (the Agents tab's routes), same-origin as the browser. */
async function route(method, path, body) {
  const s = await signIn();
  const res = await fetch(`${s.base}${path}`, {
    method, headers: { cookie: s.cookie, origin: s.origin, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HopError({ component: 'os-ui', hop: `${method} ${path}`, reason: `HTTP ${res.status} ${data.error ?? ''}`.trim(), detail: data });
  return data;
}

let rpcId = 0;
/** An MCP tools/call with the user's own bearer — the external caller's door. */
async function mcp(name, args) {
  const s = await signIn();
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(280000),
  });
  const text = await res.text();
  let rpc;
  try { rpc = JSON.parse(text); } catch { const l = text.split('\n').find((x) => x.startsWith('data:')); rpc = l ? JSON.parse(l.slice(5)) : {}; }
  if (rpc.error) throw new HopError({ component: 'os-ui', hop: `mcp ${name}`, reason: `${rpc.error.code}: ${rpc.error.message}` });
  const out = rpc.result?.content?.map((c) => c.text ?? '').join('') ?? '';
  let payload;
  try { payload = JSON.parse(out); } catch { payload = out; }
  if (rpc.result?.isError) throw new HopError({ component: 'os-ui', hop: `mcp ${name}`, reason: `${payload?.code ?? 'tool_error'}: ${payload?.reason ?? out}`.slice(0, 400) });
  return payload;
}

/** Follow a run over MCP until it settles (worker mode answers `queued` first). */
async function settledRun(runId) {
  return waitFor(async () => {
    const r = await mcp('get_agent_run', { runId });
    return ['done', 'failed', 'parked', 'interrupted'].includes(r.status) ? r : null;
  }, { component: 'os-ui', hop: 'mcp get_agent_run', what: `run ${runId} settled`, timeoutMs: 300000, everyMs: 5000 });
}

const jobRow = async (runId) => (await pg.rows(RUNS_DB, `select run_id, system_id, status, kind, input->>'trigger' as trigger, error from run_jobs where run_id = '${runId.replace(/'/g, '')}'`))[0];
const doneFrame = async (runId) => (await pg.rows(RUNS_DB, `select seq, data::text as data from run_events where run_id = '${runId.replace(/'/g, '')}' and event = 'done' order by seq desc limit 1`))[0];

// ------------------------------------------------------------------------------- the probe

/** Every object with a string `id` and `name` anywhere in a list payload (grouped or paged). */
function systemsIn(payload, out = []) {
  if (Array.isArray(payload)) payload.forEach((x) => systemsIn(x, out));
  else if (payload && typeof payload === 'object') {
    if (typeof payload.id === 'string' && typeof payload.name === 'string') out.push(payload);
    else Object.values(payload).forEach((x) => systemsIn(x, out));
  }
  return out;
}

/**
 * Earlier probes a run left behind (a cancelled job never reaches after()): clear each one's
 * schedule (deletes its CronJob) and archive it, through the same API a user has, BEFORE a new
 * probe is made — so a stale `* * * * *` schedule can never keep firing.
 */
async function sweepEarlierProbes() {
  const listed = await mcp('list_agent_systems', {});
  const stale = systemsIn(listed).filter((s) => s.name.startsWith('e2e-schedule-api-probe-') && s.name !== PROBE_NAME && s.archived !== true);
  for (const s of stale) {
    const path = `/api/agents/systems/${encodeURIComponent(s.id)}`;
    await route('POST', `${path}/schedule`, { kind: 'manual' });
    await route('POST', path, { action: 'archive' });
    console.log(`swept an earlier probe: ${s.id}`);
  }
  return stale.length;
}

const probe = () => J.step('probe', async () => {
  await sweepEarlierProbes();
  const sys = await mcp('create_agent_system', { name: PROBE_NAME, template: 'blank', model: 'standard' });
  const agentId = (sys.agents ?? [])[0]?.id;
  if (!agentId) throw new HopError({ component: 'os-ui', hop: 'mcp create_agent_system', reason: 'the blank template returned no agent' });
  await mcp('commit_agent_files', {
    systemId: sys.id,
    files: [{ path: `agents/${agentId}/AGENT.md`, content: `# Probe\nYou are an acceptance probe. Whatever the message, reply with exactly: ${REPLY}\nUse no tools.` }],
  });
  return { id: sys.id, agentId };
});

/** Cleanup whatever happened: stop the schedule (deletes the CronJob), then archive the probe. */
async function cleanup() {
  const p = await probe().catch(() => null);
  if (!p) return;
  const path = `/api/agents/systems/${encodeURIComponent(p.id)}`;
  await route('POST', `${path}/schedule`, { kind: 'manual' }).catch((e) => console.log(`cleanup: schedule NOT cleared for ${p.id}: ${e.reason ?? e.message}`));
  await route('POST', path, { action: 'archive' }).catch((e) => console.log(`cleanup: probe ${p.id} NOT archived: ${e.reason ?? e.message}`));
}

// ---------------------------------------------------------------------- 1. the API door (MCP)

const apiRun = () => J.step('api run', async () => {
  const { id } = await probe();
  const started = await mcp('run_agent_system', { systemId: id, message: 'ping' });
  check(typeof started.runId === 'string' && started.runId, 'os-ui', 'run_agent_system returns a runId', started);
  const settled = started.status === 'done' ? started : await settledRun(started.runId);
  return { runId: started.runId, started, settled };
});

function register() {
  J.assertion('g1.1', { hop: 'run_agent_system (MCP bearer from My MCP access) starts a run that completes', record: 'MCP run_agent_system → get_agent_run' }, async () => {
    const { settled } = await apiRun();
    check(settled.status === 'done', 'os-ui', 'the API-started run is done', { status: settled.status, failureReason: settled.failureReason });
  });

  J.assertion('g1.2', { hop: 'the API run is a run_jobs row: done, trigger=api, with a done frame', record: `${RUNS_DB}.run_jobs + run_events` }, async () => {
    const { runId } = await apiRun();
    const row = await jobRow(runId);
    check(row, 'postgres', `run_jobs has the row for ${runId}`, row);
    check(row.status === 'done', 'postgres', 'run_jobs.status is done', row);
    check(row.trigger === 'api', 'postgres', "run_jobs.input->>'trigger' is api", row);
    check(await doneFrame(runId), 'postgres', 'run_events holds the done frame', null);
  });

  J.assertion('g1.3', { hop: 'the result reads back: the reply the probe was told to give', record: 'run_events done frame (finalText)' }, async () => {
    const { runId } = await apiRun();
    const frame = await doneFrame(runId);
    check(frame && frame.data.includes(REPLY), 'postgres', `the done frame carries the probe reply ${REPLY}`, frame?.data?.slice(0, 300));
  });

  // ------------------------------------------------------------------ 2. the real scheduler

  const scheduled = () => J.step('scheduled run', async () => {
    const { id } = await probe();
    // A schedule runs the PINNED definition: take the probe live first.
    await mcp('go_live', { kind: 'agent', id });
    const saved = await route('POST', `/api/agents/systems/${encodeURIComponent(id)}/schedule`, { kind: 'cron', cron: '* * * * *' });
    if (!saved.cron?.ok) throw new HopError({ component: 'kubernetes', hop: 'os-ui provisions the schedule CronJob', reason: saved.cron?.detail ?? 'no cron outcome' });
    const cronName = saved.cron.name;
    // The CronJob CONTROLLER fires it (ownerReference CronJob) — the harness never creates the Job.
    // A FAILED trigger Job ends the wait at once: `waitFor` swallows a thrown error and keeps
    // polling, so the poll RETURNS the failure and it is thrown after the wait.
    const seen = await waitFor(async () => {
      const jobs = (await getJson('jobs', null, NS)).items.filter((j) => (j.metadata.ownerReferences ?? []).some((o) => o.kind === 'CronJob' && o.name === cronName));
      const doneJob = jobs.find((j) => (j.status?.succeeded ?? 0) > 0);
      if (doneJob) return { job: doneJob };
      const failedJob = jobs.find((j) => (j.status?.failed ?? 0) > 0 || (j.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True'));
      return failedJob ? { failed: failedJob } : null;
    }, { component: 'kubernetes', hop: `cronjob ${cronName}`, what: 'a Job created by the CronJob controller that succeeded', timeoutMs: 240000, everyMs: 5000 });
    if (seen.failed) {
      // Stop the every-minute schedule now; after() also clears it.
      await route('POST', `/api/agents/systems/${encodeURIComponent(id)}/schedule`, { kind: 'manual' }).catch(() => undefined);
      throw new HopError({ component: 'kubernetes', hop: `job ${seen.failed.metadata.name}`, reason: 'the scheduled trigger Job failed (os-ui refused the scheduled run — e.g. autonomous agents off — or the pod could not start or reach os-ui)' });
    }
    const job = seen.job;
    // One firing is the proof; stop the schedule before it fires again.
    await route('POST', `/api/agents/systems/${encodeURIComponent(id)}/schedule`, { kind: 'manual' });
    const row = await waitFor(async () => {
      const rows = await pg.rows(RUNS_DB, `select run_id, status, kind, input->>'trigger' as trigger, error from run_jobs where system_id = '${id.replace(/'/g, '')}' and input->>'trigger' = 'schedule' order by created_at desc limit 1`);
      return rows[0] && ['done', 'failed', 'parked'].includes(rows[0].status) ? rows[0] : null;
    }, { component: 'postgres', hop: 'run_jobs', what: 'a settled run_jobs row with trigger=schedule for the probe', timeoutMs: 300000, everyMs: 5000 });
    return { id, cronName, job, row };
  });

  J.assertion('g2.1', { hop: 'saving a cron schedule provisions a CronJob that reads the bearer from the chart Secret', record: 'Kubernetes Job created from the CronJob (pod template env secretKeyRef, labels)' }, async () => {
    // The CronJob itself is deleted once the schedule is cleared, so read the Job it created: its
    // pod template IS the CronJob's jobTemplate.
    const { cronName, job } = await scheduled();
    const env = job.spec.template.spec.containers[0].env ?? [];
    const ref = env.find((e) => e.name === 'RUNTIME_TOKEN')?.valueFrom?.secretKeyRef;
    check(ref?.name === 'agent-runtime-token' && ref?.key === 'token', 'kubernetes', `the ${cronName} trigger reads agent-runtime-token/token`, ref);
    check(job.spec.template.metadata?.labels?.['app.kubernetes.io/component'] === 'agent-schedule', 'kubernetes', 'the trigger pod carries component=agent-schedule (its egress policy)', job.spec.template.metadata?.labels);
  });

  J.assertion('g2.2', { hop: 'the CronJob controller fires and the scheduled run completes: run_jobs done, trigger=schedule', record: `Kubernetes Job (owner CronJob) + ${RUNS_DB}.run_jobs` }, async () => {
    const { row } = await scheduled();
    check(row.status === 'done', 'postgres', 'the scheduled run is done', row);
    check(await doneFrame(row.run_id), 'postgres', 'run_events holds the scheduled run’s done frame', null);
  });

  J.assertion('g2.3', { hop: 'clearing the schedule deletes the CronJob', record: 'Kubernetes CronJob (absent)' }, async () => {
    const { cronName } = await scheduled();
    let present = true;
    try { await getJson('cronjob', cronName, NS); } catch (err) {
      if (/NotFound|not found/i.test(err.reason ?? '')) present = false; else throw err;
    }
    check(!present, 'kubernetes', `cronjob ${cronName} is gone after the schedule was cleared`, 'present');
  });
}

// ------------------------------------------------------------------------------- the gate

if (!PROBE_USER || !PROBE_PASSWORD) {
  const dir = process.env.E2E_REPORT_DIR ?? join(process.cwd(), 'report');
  appendFileSync(join(dir, 'skipped.jsonl'), `${JSON.stringify({ file: 'journeys/journey-g-agent-triggers.e2e.mjs', reason: 'no probe credential: set E2E_PROBE_USER / E2E_PROBE_PASSWORD (dev: Secret e2e-probe-credentials, keys username/password)' })}\n`);
  console.log('skip journey-g-agent-triggers: no probe credential');
} else {
  register();
  after(cleanup);
}
