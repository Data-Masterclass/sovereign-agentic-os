#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Capacity gate — CPU and memory requests and limits of the rendered chart vs the node
 * USER STORY: As an operator I want CI and the release to fail when the chart asks for more CPU or
 *             memory than the node can give, so a new component never lands on a full node and
 *             fails to schedule, or gets OOM-killed, without anyone being told.
 * ARCHITECTURE:
 *   - Reads the node budget from `charts/sovereign-agentic-os/capacity.yaml`: allocatable × node
 *     count, the thresholds (percent), and the pods on the node that the chart does not render.
 *   - Renders the chart with `helm template` for each profile (default values, and
 *     `values.stackit-managed.yaml`) and parses every document (js-yaml from os-ui's dependencies).
 *   - Sums long-running pods only: Deployment and StatefulSet (× replicas), DaemonSet (× nodes),
 *     ReplicaSet, bare Pod. Helm hooks (tests, migrations) and Jobs/CronJobs are transient and are
 *     listed, not summed: the 15 % left by the 85 % threshold is their headroom (00 §10.1).
 *   - A pod's effective request/limit is the Kubernetes rule: max(sum of app containers + sidecar
 *     init containers, the largest ordinary init container). A container that sets a limit but no
 *     request gets request = limit, as the API server defaults it.
 *   - Fails (exit 1) when, for any profile, requests (CPU or memory) or memory limits exceed their
 *     threshold, or when a long-running container sets no memory request (it would be invisible to
 *     the scheduler and to this gate).
 *   - Fails when a profile renders fewer long-running workloads than `minimumWorkloads` in
 *     capacity.yaml: an empty render (wrong values, a broken template) must not pass on nothing.
 *   - `--values <file>` (repeatable) adds an overlay to every profile; `--profile <name>` limits the
 *     run to one profile; `--json` prints the totals as JSON; `--skip-schema-validation` is passed
 *     to `helm template` (deploy.sh renders that way). deploy.sh runs `--profile default` with the
 *     live release values and VALUES_OVERLAY, i.e. exactly what its `helm upgrade` applies.
 *   - `--compare-live <context>` (read-only: `kubectl get pods -A -o json`) prints the live node
 *     totals next to the prediction and fails if they differ by more than 5 % — the WP-47 live
 *     evidence. Use it with the live release's values as `--values`.
 *   - SKIPS (exit 0, loudly) without helm, the subchart `.tgz` files or js-yaml; in CI
 *     (`process.env.CI`) a skip is a FAILURE, as in `check-consoles-not-public.mjs`.
 *   - Wired into `os-ui/scripts/gate.sh` (CI), `scripts/release.sh` (release gate) and
 *     `scripts/deploy.sh` (before the backup and `helm upgrade`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const RELEASE = 'agentic-os';
const NAME = 'check-capacity';
const PROFILES = { default: [], stackit: [join(repo, 'values.stackit-managed.yaml')] };

// ---- arguments ----------------------------------------------------------------------------
const args = process.argv.slice(2);
const overlays = [];
let only = null;
let asJson = false;
let liveContext = null;
let skipSchema = false;
let budgetFile = join(CHART, 'capacity.yaml');
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) usage(`${a} needs a value`);
    return args[++i];
  };
  if (a === '--values' || a === '-f') overlays.push(resolve(next()));
  else if (a === '--profile') only = next();
  else if (a === '--json') asJson = true;
  else if (a === '--skip-schema-validation') skipSchema = true;
  else if (a === '--compare-live') liveContext = next();
  else if (a === '--budget') budgetFile = resolve(next());
  else if (a === '-h' || a === '--help') usage();
  else usage(`unknown argument ${a}`);
}
function usage(err) {
  const text = 'usage: node scripts/check-capacity.mjs [--profile default|stackit] [--values <file>]... [--json] [--skip-schema-validation] [--compare-live <kube-context>] [--budget <capacity.yaml>]';
  if (err) { console.error(`${NAME}: ${err}\n${text}`); process.exit(2); }
  console.log(text); process.exit(0);
}
if (only && !PROFILES[only]) usage(`unknown profile ${only} (known: ${Object.keys(PROFILES).join(', ')})`);
for (const f of overlays) if (!existsSync(f)) usage(`values file not found: ${f}`);

function skip(reason) {
  if (process.env.CI) {
    console.error(`${NAME}: ${reason} — FAILING because CI is set; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`${NAME}: ${reason} — checks SKIPPED`);
  process.exit(0);
}

let yaml;
try {
  yaml = createRequire(resolve(repo, 'os-ui/package.json'))('js-yaml');
} catch {
  skip('js-yaml not installed (run `npm --prefix os-ui ci`)');
}
try {
  execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
} catch {
  skip('helm not on PATH');
}
const deps = join(CHART, 'charts');
if (!existsSync(deps) || !readdirSync(deps).some((f) => f.endsWith('.tgz'))) {
  skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');
}

// ---- quantities ---------------------------------------------------------------------------
const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
const DEC = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
/** Kubernetes quantity → number (cores for cpu, bytes for memory). Throws on garbage. */
export function quantity(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|n|u|m|k|K|M|G|T)?$/.exec(String(v).trim());
  if (!m) throw new Error(`not a Kubernetes quantity: ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  const s = m[2] ?? '';
  return BIN[s] ? n * BIN[s] : n * DEC[s];
}
const zero = () => ({ rc: 0, rm: 0, lc: 0, lm: 0 });
const add = (a, b, k = 1) => ({ rc: a.rc + k * b.rc, rm: a.rm + k * b.rm, lc: a.lc + k * b.lc, lm: a.lm + k * b.lm });
const max = (a, b) => ({ rc: Math.max(a.rc, b.rc), rm: Math.max(a.rm, b.rm), lc: Math.max(a.lc, b.lc), lm: Math.max(a.lm, b.lm) });

function containerRes(c) {
  const r = c.resources ?? {};
  const lim = r.limits ?? {};
  const req = r.requests ?? {};
  // The API server defaults a missing request to the limit.
  return {
    rc: quantity(req.cpu ?? lim.cpu),
    rm: quantity(req.memory ?? lim.memory),
    lc: quantity(lim.cpu),
    lm: quantity(lim.memory),
  };
}
/** Effective pod resources (the scheduler's and `kubectl describe node`'s rule). */
export function podRes(spec) {
  let app = zero();
  for (const c of spec.containers ?? []) app = add(app, containerRes(c));
  let init = zero();
  let sidecars = zero();
  for (const c of spec.initContainers ?? []) {
    const r = containerRes(c);
    if (c.restartPolicy === 'Always') sidecars = add(sidecars, r); // native sidecar: runs alongside
    else init = max(init, add(sidecars, r));
  }
  return max(add(app, sidecars), init);
}

// ---- budget -------------------------------------------------------------------------------
const budget = yaml.load(readFileSync(budgetFile, 'utf8'));
const nodes = Number(budget.node?.count);
const alloc = { cpu: quantity(budget.node?.allocatable?.cpu), memory: quantity(budget.node?.allocatable?.memory) };
if (!(nodes >= 1) || !(alloc.cpu > 0) || !(alloc.memory > 0)) {
  console.error(`${NAME}: ${budgetFile} needs node.count ≥ 1 and node.allocatable.{cpu,memory}`);
  process.exit(2);
}
const T = budget.thresholds ?? {};
const thresholds = { rc: T.requests?.cpu, rm: T.requests?.memory, lm: T.limits?.memory };
for (const [k, v] of Object.entries(thresholds)) {
  if (!(typeof v === 'number' && v > 0 && v <= 100)) {
    console.error(`${NAME}: ${budgetFile} threshold ${k} must be a percent in (0, 100], got ${v}`);
    process.exit(2);
  }
}
let outside = zero();
for (const o of budget.outsideChart ?? []) {
  const r = { rc: quantity(o.requests?.cpu), rm: quantity(o.requests?.memory), lc: quantity(o.limits?.cpu), lm: quantity(o.limits?.memory) };
  outside = add(outside, r, o.perNode ? nodes : 1);
}
// A render with (almost) no workloads sums to (almost) nothing and would pass: fail it instead.
const minimumWorkloads = Number(budget.minimumWorkloads ?? 1);
if (!(Number.isInteger(minimumWorkloads) && minimumWorkloads >= 1)) {
  console.error(`${NAME}: ${budgetFile} minimumWorkloads must be an integer ≥ 1, got ${budget.minimumWorkloads}`);
  process.exit(2);
}
const capacity = { rc: alloc.cpu * nodes, rm: alloc.memory * nodes, lc: alloc.cpu * nodes, lm: alloc.memory * nodes };

// ---- render and sum -----------------------------------------------------------------------
const LONG_RUNNING = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod']);
const TRANSIENT = new Set(['Job', 'CronJob']);

function render(files) {
  const flags = files.flatMap((f) => ['-f', f]);
  const extra = skipSchema ? ['--skip-schema-validation'] : [];
  const text = execFileSync('helm', ['template', RELEASE, CHART, '-n', 'agentic-os', ...flags, ...extra], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return yaml.loadAll(text).filter(Boolean);
}

/** Sum a list of rendered documents. Returns { total, rows, transient, problems }. */
export function sumDocs(docs) {
  const rows = [];
  const transient = [];
  const problems = [];
  let total = zero();
  for (const d of docs) {
    const kind = d.kind;
    const name = `${kind}/${d.metadata?.name}`;
    const hook = d.metadata?.annotations?.['helm.sh/hook'];
    if (TRANSIENT.has(kind) || (hook && (LONG_RUNNING.has(kind) || TRANSIENT.has(kind)))) {
      const spec = kind === 'CronJob' ? d.spec?.jobTemplate?.spec?.template?.spec
        : kind === 'Pod' ? d.spec : d.spec?.template?.spec;
      if (spec) transient.push({ name: hook ? `${name} (helm hook: ${hook})` : name, res: podRes(spec) });
      continue;
    }
    if (!LONG_RUNNING.has(kind)) continue;
    const spec = kind === 'Pod' ? d.spec : d.spec?.template?.spec;
    if (!spec) continue;
    const replicas = kind === 'DaemonSet' ? nodes : kind === 'Pod' ? 1 : (d.spec?.replicas ?? 1);
    for (const c of spec.containers ?? []) {
      if (!c.resources?.requests?.memory && !c.resources?.limits?.memory) {
        problems.push(`${name} container "${c.name}" sets no memory request — invisible to the scheduler and to this gate`);
      }
    }
    const res = podRes(spec);
    rows.push({ name, replicas, res, priorityClassName: spec.priorityClassName ?? null });
    total = add(total, res, replicas);
  }
  return { total, rows, transient, problems };
}

const cores = (v) => `${Math.round(v * 1000)}m`;
const gib = (v) => `${(v / 2 ** 30).toFixed(2)}Gi`;
const pct = (v, cap) => (100 * v) / cap;

const results = {};
const failures = [];
for (const [profile, files] of Object.entries(PROFILES)) {
  if (only && profile !== only) continue;
  let docs;
  try {
    docs = render([...files, ...overlays]);
  } catch (e) {
    failures.push(`${profile}: helm template failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    continue;
  }
  const s = sumDocs(docs);
  const grand = add(s.total, outside);
  const p = { rc: pct(grand.rc, capacity.rc), rm: pct(grand.rm, capacity.rm), lc: pct(grand.lc, capacity.lc), lm: pct(grand.lm, capacity.lm) };
  results[profile] = { chart: s.total, outside, total: grand, percent: p, rows: s.rows, transient: s.transient };
  for (const msg of s.problems) failures.push(`${profile}: ${msg}`);
  if (s.rows.length < minimumWorkloads) {
    failures.push(`${profile}: the render has ${s.rows.length} long-running workloads, fewer than the ${minimumWorkloads} capacity.yaml expects — a sum of nothing is not a pass (wrong values, or a chart that renders nothing)`);
  }
  const label = { rc: 'CPU requests', rm: 'memory requests', lm: 'memory limits' };
  for (const k of Object.keys(thresholds)) {
    if (p[k] > thresholds[k]) {
      const fmt = k === 'rc' ? cores : gib;
      failures.push(`${profile}: ${label[k]} ${fmt(grand[k])} = ${p[k].toFixed(1)} % of ${nodes} × allocatable, above the ${thresholds[k]} % threshold`);
    }
  }
}

// ---- live comparison (read-only) ----------------------------------------------------------
let live = null;
if (liveContext) {
  const text = execFileSync('kubectl', ['--context', liveContext, 'get', 'pods', '-A', '-o', 'json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let t = zero();
  for (const pod of JSON.parse(text).items) {
    if (['Succeeded', 'Failed'].includes(pod.status?.phase)) continue;
    if (pod.metadata?.ownerReferences?.some((o) => o.kind === 'Job')) continue; // transient, as above
    t = add(t, podRes(pod.spec));
  }
  live = { total: t, percent: { rc: pct(t.rc, capacity.rc), rm: pct(t.rm, capacity.rm), lc: pct(t.lc, capacity.lc), lm: pct(t.lm, capacity.lm) } };
  const profile = only ?? 'default';
  const pred = results[profile]?.total;
  if (pred) {
    for (const [k, label] of [['rc', 'CPU requests'], ['rm', 'memory requests'], ['lm', 'memory limits']]) {
      const diff = live.total[k] ? (100 * (pred[k] - live.total[k])) / live.total[k] : 0;
      live[`diff_${k}`] = diff;
      if (Math.abs(diff) > 5) failures.push(`live: predicted ${label} differ from the live node by ${diff.toFixed(1)} % (more than ±5 %)`);
    }
  }
}

// ---- report -------------------------------------------------------------------------------
if (asJson) {
  console.log(JSON.stringify({ nodes, allocatable: alloc, thresholds, results, live, failures }, null, 2));
} else {
  console.log(`${NAME}: ${nodes} × node allocatable ${cores(alloc.cpu)} CPU, ${gib(alloc.memory)} memory; thresholds: requests CPU ${thresholds.rc} %, memory ${thresholds.rm} %; memory limits ${thresholds.lm} %`);
  for (const [profile, r] of Object.entries(results)) {
    console.log(`\n  profile ${profile}${overlays.length ? ` (+ ${overlays.length} overlay)` : ''}`);
    console.log('    workload'.padEnd(64) + 'x  cpu req  cpu lim   mem req   mem lim  priority');
    for (const row of r.rows.sort((a, b) => b.res.rm - a.res.rm)) {
      console.log(`    ${row.name.slice(0, 58).padEnd(60)}${String(row.replicas).padEnd(2)} ${cores(row.res.rc).padStart(7)} ${cores(row.res.lc).padStart(8)} ${gib(row.res.rm).padStart(9)} ${gib(row.res.lm).padStart(9)}  ${row.priorityClassName ?? '-'}`);
    }
    const line = (label, v) => console.log(`    ${label.padEnd(62)} ${cores(v.rc).padStart(7)} ${cores(v.lc).padStart(8)} ${gib(v.rm).padStart(9)} ${gib(v.lm).padStart(9)}`);
    line('chart total', r.chart);
    line('outside the chart (capacity.yaml outsideChart)', r.outside);
    line('node total', r.total);
    console.log(`    percent of allocatable: CPU requests ${r.percent.rc.toFixed(1)} %, CPU limits ${r.percent.lc.toFixed(1)} % (not gated), memory requests ${r.percent.rm.toFixed(1)} %, memory limits ${r.percent.lm.toFixed(1)} %`);
    if (r.transient.length) console.log(`    transient (not summed; the headroom above the threshold): ${r.transient.map((t) => t.name).join(', ')}`);
  }
  if (live) {
    console.log(`\n  live node (${liveContext}): CPU requests ${cores(live.total.rc)} (${live.percent.rc.toFixed(1)} %), memory requests ${gib(live.total.rm)} (${live.percent.rm.toFixed(1)} %), memory limits ${gib(live.total.lm)} (${live.percent.lm.toFixed(1)} %)`);
    if (live.diff_rc !== undefined) console.log(`  prediction − live: CPU requests ${live.diff_rc.toFixed(1)} %, memory requests ${live.diff_rm.toFixed(1)} %, memory limits ${live.diff_lm.toFixed(1)} %`);
  }
}
if (failures.length) {
  console.error(`${asJson ? '' : '\n'}${NAME} FAILED:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
if (!asJson) console.log(`\n${NAME}: ok — every profile fits the node under its thresholds`);
