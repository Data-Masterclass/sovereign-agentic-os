/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Negative twins for scripts/check-observability-chart.mjs (WP-05 review #1, #3–#6).
 * USER STORY: As the owner I want proof that each guard really fails: a REAL render of the chart is
 *             mutated in exactly one way and the checker must name that rule.
 * ARCHITECTURE:
 *   - One `helm template` of the default profile (os-ui worker on, so both OS_VERSION carriers
 *     render); the clean render passes; each twin edits the parsed manifests (js-yaml) and re-dumps.
 *   - Twins: an extra ingress peer, a wildcard namespace selector, a missing policy, a wildcard and
 *     a user-apps file_log path, no masking step, VictoriaLogs back at 1Gi, a typed-in OS_VERSION
 *     (the verifier's 1.0.0 vs 0.9.20 fake), and the LiteLLM option switched on; on the STACKIT
 *     profile the kubelet egress without a node network, to 0.0.0.0/0, to a pod or on an extra port.
 *   - The os-ui write-path scan is checked on a throwaway tree with one offending file.
 *   - Run: node --test scripts/tests/check-observability-chart.test.mjs (needs helm, subcharts, os-ui deps).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, osUiWrites } from '../check-observability-chart.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = createRequire(join(REPO, 'os-ui', 'package.json'))('js-yaml');
const RENDER = execFileSync('helm', ['template', 'agentic-os', join(REPO, 'charts', 'sovereign-agentic-os'), '--set', 'osUI.worker.enabled=true'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function mutate(fn) {
  const docs = yaml.loadAll(RENDER).filter(Boolean);
  fn(docs);
  return docs.map((d) => yaml.dump(d, { lineWidth: -1 })).join('---\n');
}
const find = (docs, kind, name) => docs.find((d) => d.kind === kind && d.metadata?.name === name);
const collectorCfg = (docs, fn) => {
  const cm = find(docs, 'ConfigMap', 'otel-collector');
  const cfg = yaml.load(cm.data['config.yaml']);
  fn(cfg);
  cm.data['config.yaml'] = yaml.dump(cfg, { lineWidth: -1 });
};
const fails = (text, re) => {
  const errs = check(text);
  assert.ok(errs.some((e) => re.test(e)), `expected ${re}, got ${JSON.stringify(errs)}`);
};

test('the clean render passes', () => {
  assert.deepEqual(check(RENDER), []);
});

test('twin: an extra peer (Dagster code location) on VictoriaLogs fails (1)', () => {
  fails(mutate((d) => find(d, 'NetworkPolicy', 'victoria-logs-allow-collector-and-os-ui').spec.ingress[0].from.push({ podSelector: { matchLabels: { 'app.kubernetes.io/component': 'dagster-user-deployments' } } })), /\(1\) victoria-logs-allow-collector-and-os-ui: admits/);
});

test('twin: a namespace-wide peer on the Collector fails (1)', () => {
  fails(mutate((d) => find(d, 'NetworkPolicy', 'otel-collector-allow-os-only').spec.ingress[0].from.push({ namespaceSelector: {} })), /\(1\) otel-collector-allow-os-only: admits .*non-pod peer/);
});

test('twin: no VictoriaMetrics policy fails (1)', () => {
  fails(mutate((d) => d.splice(d.indexOf(find(d, 'NetworkPolicy', 'victoria-metrics-allow-collector-and-os-ui')), 1)), /\(1\) NetworkPolicy victoria-metrics-allow-collector-and-os-ui does not render/);
});

test('twin: a policy that selects nothing fails (1)', () => {
  fails(mutate((d) => { find(d, 'NetworkPolicy', 'victoria-logs-allow-collector-and-os-ui').spec.podSelector.matchLabels['app.kubernetes.io/name'] = 'nothing'; }), /\(1\) victoria-logs-allow-collector-and-os-ui: podSelector does not select/);
});

test('twin: file_log reading every namespace, or the user-apps one, fails (2)', () => {
  fails(mutate((d) => collectorCfg(d, (c) => { c.receivers.file_log.include = ['/var/log/pods/*/*/*.log']; })), /\(2\) file_log include .* is not one platform namespace/);
  fails(mutate((d) => collectorCfg(d, (c) => { c.receivers.file_log.include.push('/var/log/pods/agentic-apps_*/*/*.log'); })), /\(2\) file_log reads the user-apps namespace agentic-apps/);
});

test('twin: a logs pipeline without the masking step fails (3)', () => {
  fails(mutate((d) => collectorCfg(d, (c) => { c.service.pipelines.logs.processors = c.service.pipelines.logs.processors.filter((p) => p !== 'transform/redact_secrets'); })), /\(3\) the logs pipeline has no transform\/redact_secrets/);
});

test('twin: VictoriaLogs back at a 1Gi limit fails (4)', () => {
  fails(mutate((d) => { find(d, 'StatefulSet', 'victoria-logs').spec.template.spec.containers[0].resources.limits.memory = '1Gi'; }), /\(4\) victoria-logs memory limit 1Gi is above 512Mi/);
});

test('twin: a typed-in OS_VERSION (1.0.0 while the image is another tag) fails (5)', () => {
  fails(mutate((d) => { for (const e of find(d, 'Deployment', 'os-ui').spec.template.spec.containers[0].env) if (e.name === 'OS_VERSION') e.value = '1.0.0'; }), /\(5\) os-ui OS_VERSION=1\.0\.0 but it runs image tag/);
  fails(mutate((d) => { const c = find(d, 'Deployment', 'os-ui-worker').spec.template.spec.containers[0]; c.env = c.env.filter((e) => e.name !== 'OS_VERSION'); }), /\(5\) os-ui-worker has no OS_VERSION/);
});

test('twin: the LiteLLM orphan-span option switched on fails (6)', () => {
  fails(mutate((d) => collectorCfg(d, (c) => { c.service.pipelines['traces/langfuse'] = { receivers: ['otlp'], exporters: ['otlp_http/victoriametrics'] }; })), /\(6\) the LiteLLM orphan-span option is ON/);
});

test('twin: os-ui code posting to VictoriaLogs is found (7)', () => {
  const root = mkdtempSync(join(tmpdir(), 'obs-writes-'));
  try {
    mkdirSync(join(root, 'core', 'z'), { recursive: true });
    writeFileSync(join(root, 'core', 'z', 'forge.ts'), "export const forge = (b: string) => fetch(`${b}/insert/jsonline`, { method: 'POST' });\n");
    writeFileSync(join(root, 'core', 'z', 'ok.ts'), "// select/insert/update are SQL words here, not a path\nexport const ok = 1;\n");
    assert.deepEqual(osUiWrites(root), [join('core', 'z', 'forge.ts')]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// (8) the Collector's kubelet egress on the production (STACKIT) profile: node network only.
const STACKIT = (...extra) => execFileSync('helm', ['template', 'agentic-os', join(REPO, 'charts', 'sovereign-agentic-os'), '-f', join(REPO, 'values.stackit-managed.yaml'), ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const STACKIT_RENDER = STACKIT();
const kubeletRule = (docs) => find(docs, 'NetworkPolicy', 'otel-collector-kubelet-egress').spec.egress[0];
const mutateStackit = (fn) => {
  const docs = yaml.loadAll(STACKIT_RENDER).filter(Boolean);
  fn(docs);
  return docs.map((d) => yaml.dump(d, { lineWidth: -1 })).join('---\n');
};
const failsProd = (text, re) => {
  const errs = check(text, { nodeNetwork: true });
  assert.ok(errs.some((e) => re.test(e)), `expected ${re}, got ${JSON.stringify(errs)}`);
};

test('the STACKIT render narrows the kubelet egress to the SKE node network and passes (8)', () => {
  assert.deepEqual(kubeletRule(yaml.loadAll(STACKIT_RENDER).filter(Boolean)).to, [{ ipBlock: { cidr: '10.0.0.0/24' } }]);
  assert.deepEqual(check(STACKIT_RENDER, { nodeNetwork: true }), []);
});

test('twin: the STACKIT render with no node network (nodeCidrs=[]) reaches :10250 anywhere and fails (8)', () => {
  failsProd(STACKIT('--set', 'observability.collector.kubeletStats.nodeCidrs=null'), /\(8\) otel-collector-kubelet-egress: :10250 to ANY address/);
});

test('twin: 0.0.0.0/0, a pod destination or an extra port on the kubelet rule fails (8)', () => {
  failsProd(mutateStackit((d) => { kubeletRule(d).to = [{ ipBlock: { cidr: '0.0.0.0/0' } }]; }), /\(8\) .*0\.0\.0\.0\/0 is any address/);
  failsProd(mutateStackit((d) => { kubeletRule(d).to.push({ podSelector: {} }); }), /\(8\) .*not a node-network ipBlock/);
  failsProd(mutateStackit((d) => { kubeletRule(d).ports.push({ protocol: 'TCP', port: 22 }); }), /\(8\) .*expected exactly TCP\/10250/);
});
