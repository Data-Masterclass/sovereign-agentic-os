#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    The observability stack's guard rails, on the RENDERED chart (WP-05 review #1, #3–#6)
 * USER STORY: As an operator I want CI to fail when the log store can be read or written by pods
 *             that are not the OS, when user apps' logs or unmasked secrets can reach it, when it
 *             outgrows its memory budget, or when os-ui is told a version that is not its own.
 * ARCHITECTURE:
 *   - Renders the chart (default profile, plus the STACKIT profile) with `helm template` and checks:
 *     (1) ingress policies `victoria-metrics-allow-collector-and-os-ui`, `victoria-logs-allow-
 *         collector-and-os-ui`, `otel-collector-allow-os-only` render, are Ingress-only, select the
 *         rendered pods, and admit EXACTLY the expected peers on the expected ports;
 *     (2) the Collector's file_log `include` names only platform namespaces — never the user-apps
 *         namespace (softwareRunner.namespace) — and a render that lists it FAILS;
 *     (3) the logs pipeline runs `transform/redact_secrets` before it exports;
 *     (4) VictoriaLogs' memory limit is at most 512Mi;
 *     (5) os-ui (and os-ui-worker when rendered) get OS_VERSION equal to their own image tag;
 *     (6) the LiteLLM orphan-span option is off by default;
 *     (7) no os-ui source calls a Victoria write or delete path (os-ui only reads).
 *   - `--rendered <file>` checks a given manifest stream instead (the negative twins mutate a real
 *     render: scripts/tests/check-observability-chart.test.mjs).
 *   - Loud skip without helm or the subcharts on a laptop; a skip FAILS in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const TAG = 'check-observability-chart';
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

function skip(why) {
  if (process.env.CI) { console.error(`${TAG}: ${why} — FAILING because CI is set.`); process.exit(1); }
  console.log(`${TAG}: SKIPPED — ${why}`); process.exit(0);
}
let yaml;
try { yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml'); } catch { skip('js-yaml not installed (npm --prefix os-ui ci)'); }

function render(extra = []) {
  return execFileSync('helm', ['template', 'agentic-os', CHART, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

const EXPECT = {
  'victoria-metrics-allow-collector-and-os-ui': { target: 'victoria-metrics', rules: [{ peers: ['os-ui', 'otel-collector'], ports: [8428] }] },
  'victoria-logs-allow-collector-and-os-ui': { target: 'victoria-logs', rules: [{ peers: ['os-ui', 'otel-collector'], ports: [9428] }] },
  'otel-collector-allow-os-only': { target: 'otel-collector', rules: [{ peers: ['os-ui', 'os-ui-worker'], ports: [4317, 4318, 8888, 13133] }] },
};

export function check(text, { appsNamespace = 'agentic-apps' } = {}) {
  const docs = yaml.loadAll(text).filter(Boolean);
  const errs = [];
  const byKind = (k, n) => docs.find((d) => d.kind === k && d.metadata?.name === n);
  const podLabels = (name) => {
    const w = docs.find((d) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind) && d.metadata?.name === name);
    return w?.spec?.template?.metadata?.labels;
  };
  // (1) ingress policies
  for (const [name, exp] of Object.entries(EXPECT)) {
    const p = byKind('NetworkPolicy', name);
    if (!p) { errs.push(`(1) NetworkPolicy ${name} does not render`); continue; }
    if (JSON.stringify(p.spec.policyTypes) !== '["Ingress"]') errs.push(`(1) ${name}: policyTypes must be exactly [Ingress]`);
    const labels = podLabels(exp.target);
    const sel = p.spec.podSelector?.matchLabels ?? {};
    if (!labels || !Object.keys(sel).length || Object.entries(sel).some(([k, v]) => labels[k] !== v)) errs.push(`(1) ${name}: podSelector does not select the rendered ${exp.target} pods`);
    const rules = (p.spec.ingress ?? []).map((r) => ({
      peers: (r.from ?? []).map((f) => (f.namespaceSelector || f.ipBlock ? '<non-pod peer>' : f.podSelector?.matchLabels?.['app.kubernetes.io/component'] ?? f.podSelector?.matchLabels?.['app.kubernetes.io/name'] ?? '<any pod>')).sort(),
      ports: (r.ports ?? []).map((x) => x.port).sort((a, b) => a - b),
    }));
    if (JSON.stringify(rules) !== JSON.stringify(exp.rules)) errs.push(`(1) ${name}: admits ${JSON.stringify(rules)}, expected exactly ${JSON.stringify(exp.rules)}`);
  }
  // (2)(3) Collector config
  const cm = byKind('ConfigMap', 'otel-collector');
  if (!cm) errs.push('(2) the otel-collector ConfigMap does not render');
  else {
    const cfg = yaml.load(cm.data['config.yaml']);
    const fl = cfg.receivers?.file_log;
    if (fl) {
      for (const inc of fl.include ?? []) {
        const ns = inc.match(/^\/var\/log\/pods\/([a-z0-9-]+)_\*\/\*\/\*\.log$/)?.[1];
        if (!ns) errs.push(`(2) file_log include ${inc} is not one platform namespace (wildcard or odd path)`);
        else if (ns === appsNamespace) errs.push(`(2) file_log reads the user-apps namespace ${ns}`);
      }
    }
    const lp = cfg.service?.pipelines?.logs?.processors ?? [];
    const i = lp.indexOf('transform/redact_secrets');
    if (i < 0 || !cfg.processors?.['transform/redact_secrets']) errs.push('(3) the logs pipeline has no transform/redact_secrets step');
    else if (i > lp.indexOf('batch') && lp.includes('batch')) errs.push('(3) transform/redact_secrets runs after batch');
  }
  // (4) VictoriaLogs memory
  const vl = docs.find((d) => d.kind === 'StatefulSet' && d.metadata?.name === 'victoria-logs');
  const lim = vl?.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory;
  const mib = (v) => { const m = String(v).match(/^(\d+(?:\.\d+)?)(Mi|Gi)$/); return m ? Number(m[1]) * (m[2] === 'Gi' ? 1024 : 1) : Infinity; };
  if (!vl) errs.push('(4) the victoria-logs StatefulSet does not render');
  else if (mib(lim) > 512) errs.push(`(4) victoria-logs memory limit ${lim} is above 512Mi`);
  // (5) OS_VERSION = own image tag
  for (const n of ['os-ui', 'os-ui-worker']) {
    const w = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === n);
    if (!w) { if (n === 'os-ui') errs.push('(5) the os-ui Deployment does not render'); continue; }
    const c = w.spec.template.spec.containers.find((x) => x.name === n) ?? w.spec.template.spec.containers[0];
    const tag = c.image.split('@')[0].split('/').pop().split(':')[1];
    const env = (c.env ?? []).find((e) => e.name === 'OS_VERSION');
    if (!env) errs.push(`(5) ${n} has no OS_VERSION`);
    else if (env.value !== tag) errs.push(`(5) ${n} OS_VERSION=${env.value} but it runs image tag ${tag}`);
  }
  // (6) LiteLLM option off
  if (cm && yaml.load(cm.data['config.yaml']).service?.pipelines?.['traces/langfuse']) errs.push('(6) the LiteLLM orphan-span option is ON in this render (unsafe today; keep it off)');
  return errs;
}

export function osUiWrites(root = join(repo, 'os-ui')) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e) && !/\.test\.(ts|tsx|mjs)$/.test(e)) {
        const t = readFileSync(p, 'utf8');
        if (/\/(insert\/(jsonline|opentelemetry|elasticsearch|loki|datadog|journald)|api\/v1\/(import|write|admin\/tsdb\/delete_series)|opentelemetry\/v1\/(metrics|logs)|delete\/run_task)/.test(t)) out.push(relative(root, p));
      }
    }
  };
  for (const d of ['core', 'tabs', 'app', 'worker']) if (existsSync(join(root, d))) walk(join(root, d));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const given = opt('--rendered');
  let errs = [];
  if (given) errs = check(readFileSync(given, 'utf8'));
  else {
    try { execFileSync('helm', ['version'], { stdio: 'ignore' }); } catch { skip('helm not installed'); }
    if (!existsSync(join(CHART, 'charts')) || !readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'))) skip('subcharts missing (helm dependency build)');
    for (const [label, extra] of [['default', []], ['default + worker', ['--set', 'osUI.worker.enabled=true']], ['stackit', ['-f', join(repo, 'values.stackit-managed.yaml')]]]) {
      errs.push(...check(render(extra)).map((e) => `${label}: ${e}`));
    }
    // (2) a render that names the user-apps namespace must FAIL.
    try {
      render(['--set', 'observability.collector.podLogs.namespaces={agentic-os,agentic-apps}']);
      errs.push('(2) a render with podLogs.namespaces including agentic-apps did NOT fail');
    } catch (e) {
      if (!/user-apps namespace/.test(String(e.stderr))) errs.push(`(2) the agentic-apps render failed for another reason: ${String(e.stderr).slice(0, 200)}`);
    }
    for (const f of osUiWrites()) errs.push(`(7) os-ui source calls a Victoria write/delete path: ${f}`);
  }
  if (errs.length) { console.error(`${TAG}: FAIL\n  ${errs.join('\n  ')}`); process.exit(1); }
  console.log(`${TAG}: ok — ingress allow-lists exact, file_log platform-only with secret masking, VictoriaLogs ≤ 512Mi, OS_VERSION = image tag, LiteLLM option off, os-ui only reads`);
}
