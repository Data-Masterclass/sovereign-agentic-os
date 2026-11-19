#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    Live scenario runner over the OS's external MCP door (`/api/mcp`)
 * USER STORY: As the owner I want to replay the same small set of real scenarios against the
 *             live system after every deploy and get one report: per step the tool, a summary
 *             of its arguments, status, duration, response size and which assertions held.
 * ARCHITECTURE:
 *   - Reads scenarios from scripts/scenarios/*.json (and write/*.json only with --allow-write).
 *   - JSON-RPC 2.0 `tools/call` over HTTP POST with `Authorization: Bearer $OS_MCP_TOKEN`. The
 *     token is read from the environment only, never logged, never written to a report.
 *   - ONE call at a time; at least --min-interval-ms (default 1000) between call starts; at most
 *     --max-calls (default 200) per invocation, after which every remaining step is skipped.
 *   - Read-only is the default and the allowlist lives HERE (lib.mjs), not only on the server.
 *   - Steps may `save` values (by path) as variables for later steps, `forEach` over a saved
 *     list (capped by `max`), and `assert` checks; a step's `budgetMs` (or the scenario's
 *     `readBudgetMs`, default 3000) turns a slow call into a failed timing assertion.
 *   - The report records sizes, timings, error codes and assertion outcomes. Response CONTENT is
 *     never written; `record` may capture numbers/booleans and short enum-like strings only.
 *   - `initialize` is called once first to read serverInfo.version (no tool call, no data).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  checkToolAllowed, evalPath, runAssertion, substitute, latencyStats, parseToolResponse, shapeOf, recordValue,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = {
    url: process.env.OS_MCP_URL || 'https://os.agentic.datamasterclass.com/api/mcp',
    readOnly: true, allowWrite: false, sandboxFolder: '', only: [], out: join(tmpdir(), 'os-scenarios'),
    minIntervalMs: 1000, maxCalls: 200, timeoutMs: 60000, shape: false, dryRun: false, dir: HERE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--read-only') o.readOnly = true;
    else if (a === '--allow-write') { o.allowWrite = true; o.readOnly = false; }
    else if (a === '--sandbox-folder') o.sandboxFolder = next();
    else if (a === '--url') o.url = next();
    else if (a === '--only') o.only.push(...next().split(','));
    else if (a === '--out') o.out = next();
    else if (a === '--min-interval-ms') o.minIntervalMs = Math.max(1000, Number(next()));
    else if (a === '--max-calls') o.maxCalls = Math.min(200, Number(next()));
    else if (a === '--timeout-ms') o.timeoutMs = Number(next());
    else if (a === '--shape') o.shape = true;
    else if (a === '--dir') o.dir = resolve(next());
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.allowWrite && !o.sandboxFolder) throw new Error('--allow-write needs --sandbox-folder /_os-selftest');
  return o;
}

export function loadScenarios(dir, { allowWrite, only }) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  const wdir = join(dir, 'write');
  if (existsSync(wdir)) files.push(...readdirSync(wdir).filter((f) => f.endsWith('.json')).map((f) => join(wdir, f)));
  const all = files.map((f) => ({ ...JSON.parse(readFileSync(f, 'utf8')), file: f }));
  return all.filter((s) => (only.length ? only.includes(s.id) : true)).filter((s) => (s.requiresWrite ? allowWrite : true));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summariseArgs(args) {
  const s = JSON.stringify(args ?? {});
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
const RECORDABLE = (v) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 40 && /^[\w .:/+-]*$/.test(v));

export class Client {
  constructor({ url, token, minIntervalMs, maxCalls, timeoutMs, fetchImpl }) {
    Object.assign(this, { url, token, minIntervalMs, maxCalls, timeoutMs });
    this.fetch = fetchImpl || globalThis.fetch;
    this.calls = 0;
    this.lastStart = 0;
    this.id = 0;
  }
  async rpc(method, params) {
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      return { http: res.status, json, ms, bytes: text.length };
    } catch (e) {
      return { http: 0, json: null, ms: Math.round(performance.now() - t0), bytes: 0, netError: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(t);
    }
  }
  async callTool(name, args) {
    if (this.calls >= this.maxCalls) return { skipped: `call budget of ${this.maxCalls} reached` };
    this.calls++;
    return this.rpc('tools/call', { name, arguments: args });
  }
}

/** Run one scenario. Returns its report object (no response content). */
export async function runScenario(sc, client, opts, log = () => {}) {
  const vars = { sandbox: opts.sandboxFolder, runTag: opts.runTag || Date.now().toString(36), ...(sc.vars || {}) };
  const steps = [];
  const created = []; // { kind, id, step } — every object a write step made, for the cleanup list
  const readBudget = sc.readBudgetMs ?? 3000;
  let stopped = false; // a failed `stopOnFail` step skips the rest, except `cleanup` steps
  for (const step of sc.steps) {
    if (stopped && !step.cleanup) {
      steps.push({ id: step.id, tool: step.tool, status: 'skipped', note: 'an earlier stopOnFail step failed', assertions: [] });
      continue;
    }
    let iterations = [undefined];
    if (step.forEach) {
      const list = evalPath(vars, step.forEach).value;
      iterations = Array.isArray(list) ? list.slice(0, step.max ?? 3) : [];
      if (!iterations.length) {
        steps.push({ id: step.id, tool: step.tool, status: step.optional ? 'skipped' : 'failed', note: `forEach ${step.forEach} is empty`, assertions: [] });
        log(`  ${step.optional ? 'SKIP ' : 'FAIL '} ${step.id} ${step.tool}: forEach ${step.forEach} is empty`);
        continue;
      }
    }
    for (const [i, item] of iterations.entries()) {
      vars.item = item;
      const args = substitute(step.args ?? {}, vars);
      const id = step.forEach ? `${step.id}[${i}]` : step.id;
      const missing = step.requires?.find((k) => { const v = evalPath(vars, k).value; return v === undefined || v === null || v === ''; });
      if (missing) {
        steps.push({ id, tool: step.tool, status: step.optional ? 'skipped' : 'failed', note: `needs ${missing}`, assertions: [] });
        log(`  ${step.optional ? 'SKIP ' : 'FAIL '} ${id} ${step.tool}: needs ${missing}`);
        continue;
      }
      const gate = checkToolAllowed(step.tool, args, {
        allowWrite: opts.allowWrite, sandboxFolder: opts.sandboxFolder, sandboxDomain: sc.sandboxDomain,
        scenarioRequiresWrite: !!sc.requiresWrite, createdIds: created.map((c) => c.id),
      });
      if (!gate.ok) {
        steps.push({ id, tool: step.tool, status: 'refused', note: gate.reason, assertions: [] });
        log(`  REFUSED ${id} ${step.tool}: ${gate.reason}`);
        if (sc.requiresWrite && !step.cleanup) stopped = true;
        continue;
      }
      if (opts.dryRun) { steps.push({ id, tool: step.tool, args: summariseArgs(args), status: 'dry-run', assertions: [] }); continue; }
      // `retry: { times, delayMs, until: [assertions] }` — poll a read until it holds (eventual
      // consistency: an index catching up, a queued run finishing). Each attempt is a real call.
      let r;
      let parsed;
      let attempts = 0;
      for (;;) {
        attempts++;
        r = await client.callTool(step.tool, args);
        if (r.skipped) break;
        parsed = r.json ? parseToolResponse(r.json) : { data: null, isError: true, errorCode: r.netError || `http_${r.http}`, size: 0 };
        const until = step.retry?.until ?? [];
        const done = !step.retry || (!parsed.isError && until.every((a) => runAssertion(parsed.data, substitute(a, vars)).ok));
        if (done || attempts > (step.retry.times ?? 0)) break;
        await sleep(step.retry.delayMs ?? 3000);
      }
      if (r.skipped) { steps.push({ id, tool: step.tool, status: 'skipped', note: r.skipped, assertions: [] }); continue; }
      if (step.creates && !parsed.isError) {
        const cid = evalPath(parsed.data, step.creates.idPath).value;
        if (typeof cid === 'string' && cid) created.push({ kind: step.creates.kind, id: cid, step: id });
      }
      const assertions = [];
      if (step.expectError) {
        assertions.push({ ok: parsed.errorCode === step.expectError, label: `error code = ${step.expectError}`, detail: parsed.errorCode ? `got ${parsed.errorCode}` : 'no error' });
      } else {
        assertions.push({ ok: !parsed.isError, label: 'no error code', detail: parsed.isError ? `${parsed.errorCode}${parsed.reason ? ': ' + String(parsed.reason).slice(0, 160) : ''}` : '' });
      }
      const budget = step.budgetMs ?? (step.write ? sc.writeBudgetMs ?? 30000 : readBudget);
      assertions.push({ ok: r.ms <= budget, label: `duration <= ${budget} ms`, detail: `${r.ms} ms`, timing: true });
      if (!parsed.isError) for (const a of step.assert ?? []) assertions.push(runAssertion(parsed.data, substitute(a, vars)));
      for (const [k, p] of Object.entries(step.save ?? {})) {
        const v = evalPath(parsed.data, p).value;
        if (v !== undefined) vars[step.forEach ? `${k}_${i}` : k] = v;
        if (step.forEach && v !== undefined) (vars[`${k}_all`] ||= []).push(v);
      }
      const recorded = {};
      for (const [k, p] of Object.entries(step.record ?? {})) {
        const val = recordValue(parsed.data, p);
        if (RECORDABLE(val) || (typeof p === 'object' && typeof val === 'string' && val.length <= 200)) recorded[k] = val;
      }
      if (opts.shape) log(`  shape ${id}: ${JSON.stringify(shapeOf(step.shapePath ? evalPath(parsed.data, step.shapePath).value : parsed.data, 0, step.shapePath ? 6 : 4)).slice(0, 4000)}`);
      const failed = assertions.filter((a) => !a.ok);
      const hard = failed.filter((a) => !a.soft);
      const status = failed.length === 0 ? 'pass' : hard.length === 0 ? 'warn' : hard.every((a) => a.timing) ? 'slow' : 'fail';
      steps.push({ id, tool: step.tool, args: summariseArgs(step.args ?? {}), http: r.http, status, ms: r.ms, bytes: r.bytes, size: parsed.size, errorCode: parsed.errorCode, ...(attempts > 1 ? { attempts } : {}), recorded, assertions });
      log(`  ${status.toUpperCase().padEnd(5)} ${id} ${step.tool} ${r.ms}ms ${parsed.size}B${failed.length ? ' — ' + failed.map((a) => `${a.label} (${a.detail})`).join('; ') : ''}`);
      if (step.stopOnFail && status === 'fail') { stopped = true; break; }
    }
  }
  const ms = steps.filter((s) => typeof s.ms === 'number').map((s) => s.ms);
  const counted = steps.filter((s) => ['pass', 'warn', 'fail', 'slow', 'refused', 'failed'].includes(s.status));
  return {
    id: sc.id, title: sc.title, requiresWrite: !!sc.requiresWrite,
    status: counted.some((s) => ['fail', 'failed', 'refused'].includes(s.status)) ? 'fail' : counted.some((s) => s.status === 'slow') ? 'slow' : counted.some((s) => s.status === 'warn') ? 'warn' : 'pass',
    latency: latencyStats(ms), steps,
    ...(created.length ? { created } : {}),
  };
}

export function toMarkdown(report) {
  const L = [];
  L.push(`# Scenario run ${report.startedAt}`, '', `Endpoint: ${report.endpoint} · server version: ${report.serverVersion ?? 'unknown'} · mode: ${report.mode} · calls: ${report.calls}`, '');
  L.push('| Scenario | Status | Steps | min ms | median ms | max ms |', '|---|---|---|---|---|---|');
  for (const s of report.scenarios) L.push(`| ${s.id} | ${s.status} | ${s.steps.length} | ${s.latency.min ?? '-'} | ${s.latency.median ?? '-'} | ${s.latency.max ?? '-'} |`);
  L.push('', '## Latency per tool', '', '| Tool | n | min | median | p90 | max |', '|---|---|---|---|---|---|');
  for (const [t, st] of Object.entries(report.perTool)) L.push(`| ${t} | ${st.n} | ${st.min} | ${st.median} | ${st.p90} | ${st.max} |`);
  const made = report.scenarios.flatMap((s) => (s.created || []).map((c) => ({ ...c, scenario: s.id })));
  if (made.length) {
    L.push('', '## Created by this run (check every one is cleaned up)', '', '| Scenario | Kind | Id | Step |', '|---|---|---|---|');
    for (const c of made) L.push(`| ${c.scenario} | ${c.kind} | ${c.id} | ${c.step} |`);
  }
  for (const s of report.scenarios) {
    L.push('', `## ${s.id} — ${s.title ?? ''}`, '', '| Step | Tool | Args | Status | ms | bytes | Assertions |', '|---|---|---|---|---|---|---|');
    for (const st of s.steps) {
      const as = (st.assertions || []).filter((a) => !a.skipped).map((a) => `${a.ok ? 'ok' : a.soft ? 'WARN' : 'FAIL'} ${a.label}${a.ok ? '' : ` (${a.detail})`}`).join('<br>');
      const rec = st.recorded && Object.keys(st.recorded).length ? `<br>recorded: ${JSON.stringify(st.recorded)}` : '';
      L.push(`| ${st.id} | ${st.tool} | \`${(st.args ?? '').replace(/\|/g, '\\|')}\` | ${st.status}${st.note ? ': ' + st.note : ''} | ${st.ms ?? ''} | ${st.size ?? ''} | ${as}${rec} |`);
    }
  }
  return L.join('\n') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: OS_MCP_TOKEN=… node scripts/scenarios/run.mjs [--read-only] [--only id,id] [--dir scenarios-dir] [--out dir] [--url u] [--shape] [--dry-run]\n       [--allow-write --sandbox-folder /_os-selftest]   (write scenarios; needs the owner’s yes)');
    return;
  }
  const token = process.env.OS_MCP_TOKEN;
  if (!token && !opts.dryRun) throw new Error('OS_MCP_TOKEN is not set');
  const scenarios = loadScenarios(opts.dir, opts);
  if (!scenarios.length) throw new Error('no scenarios selected');
  const client = new Client({ url: opts.url, token, minIntervalMs: opts.minIntervalMs, maxCalls: opts.maxCalls, timeoutMs: opts.timeoutMs });
  const startedAt = new Date().toISOString();
  let serverVersion;
  if (!opts.dryRun) {
    const init = await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'os-scenario-runner', version: '1' } });
    if (init.http === 401) throw new Error('401 from the MCP endpoint: OS_MCP_TOKEN is not accepted');
    serverVersion = init.json?.result?.serverInfo?.version;
    console.log(`server ${init.json?.result?.serverInfo?.name ?? '?'} version ${serverVersion ?? '?'} (${init.ms} ms)`);
  }
  const results = [];
  for (const sc of scenarios) {
    console.log(`scenario ${sc.id}${sc.requiresWrite ? ' (WRITE, sandbox ' + opts.sandboxFolder + ')' : ''}`);
    results.push(await runScenario(sc, client, opts, (m) => console.log(m)));
  }
  const byTool = {};
  for (const s of results) for (const st of s.steps) if (typeof st.ms === 'number') (byTool[st.tool] ||= []).push(st.ms);
  const report = {
    startedAt, finishedAt: new Date().toISOString(), endpoint: new URL(opts.url).host + new URL(opts.url).pathname, serverVersion,
    mode: opts.allowWrite ? `write (sandbox ${opts.sandboxFolder})` : 'read-only', calls: client.calls,
    perTool: Object.fromEntries(Object.entries(byTool).map(([t, xs]) => [t, latencyStats(xs)])),
    scenarios: results,
  };
  mkdirSync(opts.out, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, '-');
  writeFileSync(join(opts.out, `scenarios-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(opts.out, `scenarios-${stamp}.md`), toMarkdown(report));
  const fails = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${results.length} scenarios · ${results.length - fails} without failures · ${client.calls} calls · report in ${resolve(opts.out)}`);
  process.exitCode = fails ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`scenario runner: ${e.message}`);
    process.exitCode = 2;
  });
}
