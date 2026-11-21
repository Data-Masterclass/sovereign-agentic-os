#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Platform ingress: default-deny plus one allowlist per platform service
 * USER STORY: As an operator I want CI to fail when a platform service (OPA, Trino, Polaris,
 *             Postgres, object storage, Valkey, ClickHouse, web-fetch, egress proxy, mock model)
 *             stops being covered by the namespace's default-deny ingress, admits another
 *             namespace, or no longer admits a workload that calls it — a missed caller is a
 *             broken product once Calico enforces the policy.
 * ARCHITECTURE:
 *   - Renders the chart (local, dev and STACKIT profiles) and parses it with js-yaml.
 *   - Evaluates Kubernetes NetworkPolicy semantics on the RENDERED objects
 *     (https://kubernetes.io/docs/concepts/services-networking/network-policies/): a pod selected by
 *     an Ingress policy accepts a peer only if some rule's `from` and `ports` admit it.
 *   - Asserts: (1) `default-deny-ingress` selects every pod; (2) every rendered workload whose pod
 *     spec (env, args, mounted ConfigMaps/Secrets) names a covered Service is admitted on that
 *     Service's target port; (3) no covered service admits a namespaceSelector or an empty `from`
 *     (except the CloudNativePG operator namespace); (4) OPA admits exactly its documented callers;
 *     (5) `networkPolicies.platformIngress.enabled=false` renders none of the policies.
 *   - The observability stack (WP-05: VictoriaMetrics, VictoriaLogs, the OTel Collector) lives under
 *     the same default-deny: its own allowlists (templates/extensions/observability/
 *     network-policies.yaml, switch `observability.networkPolicy.enabled`) must admit the Collector
 *     (found from its mounted config) and os-ui, whose URLs are config.ts defaults and therefore
 *     listed in OS_UI_CALLS, and must not admit another namespace.
 *   - CHART_DIR overrides the chart path (negative twin in scripts/tests/platform-ingress-policy.test.sh).
 *   - Loud skip on a laptop without helm / subcharts, hard failure in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = process.env.CHART_DIR ? resolve(process.env.CHART_DIR) : join(repo, 'charts', 'sovereign-agentic-os');
const TAG = 'check-platform-ingress-policy';
const NS = 'agentic-os';

function skip(why) {
  if (process.env.CI) {
    console.error(`${TAG}: ${why} — FAILING because CI is set.`);
    process.exit(1);
  }
  console.log(`${TAG}: ${why} — SKIPPED`);
  process.exit(0);
}
let yaml;
try {
  yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml');
} catch {
  skip('js-yaml not installed (os-ui/node_modules)');
}
try {
  execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
} catch {
  skip('helm not installed');
}
const dir = join(CHART, 'charts');
if (!(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.tgz')))) skip('subcharts not built');

// Service name -> why it is covered here. Ports come from the rendered Service.
const COVERED = ['opa', 'trino', 'polaris', 'pg-rw', 'pg', 'minio', 'valkey', 'clickhouse', 'web-fetch', 'egress-proxy', 'mock-model', 'query-tool', 'data-runner',
  'victoria-metrics', 'victoria-logs', 'otel-collector'];
// WP-05 observability allowlists (their own switch, observability.networkPolicy.enabled).
const OBS_POLICIES = ['victoria-metrics-allow-collector-and-os-ui', 'victoria-logs-allow-collector-and-os-ui', 'otel-collector-allow-os-only'];
// os-ui's observability calls come from config.ts defaults (VICTORIA_METRICS_URL, VICTORIA_LOGS_URL,
// OTEL_COLLECTOR_HEALTH_URL, OTEL_COLLECTOR_METRICS_URL), not from its pod spec, so they are listed.
const OS_UI_CALLS = [['victoria-metrics', 8428], ['victoria-logs', 9428], ['otel-collector', 13133], ['otel-collector', 8888]];
const POLICIES = ['default-deny-ingress', 'opa-allow-callers', 'trino-allow-callers', 'polaris-allow-callers', 'postgres-allow-callers',
  'object-storage-allow-callers', 'valkey-allow-callers', 'clickhouse-allow-callers', 'web-fetch-allow-callers',
  'egress-proxy-allow-callers', 'mock-model-allow-callers', 'query-tool-allow-callers', 'data-runner-allow-callers', 'acme-http01-solver-allow-controller'];
// References that are names in text, not calls (each with its reason).
const NOT_A_CALL = {
  'opa->trino': 'the OPA policy ConfigMap holds the `trino` Rego package',
  'pg->polaris': 'Postgres creates a database named `polaris`',
  'query-tool->litellm': 'decided: the gateway\'s MCP entry for query-tool is not admitted (agent tools run in os-ui)',
};
const OPA_PEERS = ['component=opa-reassert-principals', 'component=os-ui', 'component=os-ui-worker', 'component=trino', 'component=web-fetch'];

const failures = [];
const fail = (m) => failures.push(m);

const render = (...args) =>
  yaml.loadAll(execFileSync('helm', ['template', 'agentic-os', CHART, '-n', NS, '--skip-schema-validation', '--set', 'global.allowChartDefaultSecrets=true', ...args], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })).filter(Boolean);

function podTemplate(d) {
  const s = d.spec ?? {};
  if (d.kind === 'CronJob') return s.jobTemplate?.spec?.template;
  if (['Deployment', 'StatefulSet', 'Job', 'DaemonSet'].includes(d.kind)) return s.template;
  if (d.kind === 'Pod') return d;
  return undefined;
}
function matches(sel, labels) {
  if (!sel) return false;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (labels[k] !== String(v)) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    if (e.operator === 'In' && !(has && e.values.includes(labels[e.key]))) return false;
    if (e.operator === 'NotIn' && has && e.values.includes(labels[e.key])) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}
const nsLabels = { 'kubernetes.io/metadata.name': NS };
function peerAdmits(peer, labels) {
  if (peer.ipBlock) return false;
  if (peer.namespaceSelector && !matches(peer.namespaceSelector, nsLabels)) return false;
  if (peer.podSelector) return matches(peer.podSelector, labels);
  return !!peer.namespaceSelector;
}
function portMatches(rulePorts, port, named) {
  if (!rulePorts || rulePorts.length === 0) return true;
  return rulePorts.some((p) => p.port === port || (named && p.port === named));
}

function analyse(profile, objs) {
  const svcs = new Map(objs.filter((d) => d.kind === 'Service').map((d) => [d.metadata.name, d]));
  const nps = objs.filter((d) => d.kind === 'NetworkPolicy' && (d.spec.policyTypes ?? []).includes('Ingress'));
  const workloads = objs.map((d) => ({ d, t: podTemplate(d) })).filter((w) => w.t);
  const cms = new Map(objs.filter((d) => d.kind === 'ConfigMap').map((d) => [d.metadata.name, JSON.stringify(d.data ?? {})]));
  const secrets = new Map(objs.filter((d) => d.kind === 'Secret').map((d) => {
    let t = JSON.stringify(d.stringData ?? {});
    for (const v of Object.values(d.data ?? {})) t += Buffer.from(String(v), 'base64').toString('utf8');
    return [d.metadata.name, t];
  }));

  const deny = nps.find((n) => n.metadata.name === 'default-deny-ingress');
  if (!deny) fail(`[${profile}] default-deny-ingress is not rendered`);
  else if (Object.keys(deny.spec.podSelector ?? {}).length || deny.spec.ingress?.length) fail(`[${profile}] default-deny-ingress must select every pod and admit nothing`);

  for (const name of [...POLICIES.slice(1), ...OBS_POLICIES]) {
    const np = nps.find((n) => n.metadata.name === name);
    if (!np) continue;
    for (const r of np.spec.ingress ?? []) {
      if (!r.from || r.from.length === 0) fail(`[${profile}] ${name}: a rule with no \`from\` admits every namespace`);
      for (const p of r.from ?? []) {
        const nsName = p.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'];
        const allowedNs = (name === 'postgres-allow-callers' && nsName === 'cnpg-system') || (name === 'acme-http01-solver-allow-controller' && nsName === 'ingress-nginx');
        if (p.namespaceSelector && !allowedNs)
          fail(`[${profile}] ${name}: admits another namespace (${JSON.stringify(p.namespaceSelector)})`);
        if (p.ipBlock) fail(`[${profile}] ${name}: admits an ipBlock`);
      }
    }
  }

  // cert-manager's HTTP-01 solver pods (created in this namespace for each platform Certificate)
  // must be reachable from the ingress controller on :8089, or certificate renewals fail.
  const solverLabels = { 'acme.cert-manager.io/http01-solver': 'true' };
  const controllerNs = { 'kubernetes.io/metadata.name': 'ingress-nginx' };
  const solverAdmitted = nps.some((n) => (matches(n.spec.podSelector, solverLabels)) && (n.spec.ingress ?? []).some((r) =>
    portMatches(r.ports, 8089) && (r.from ?? []).some((p) => p.namespaceSelector && matches(p.namespaceSelector, controllerNs) && !p.podSelector)));
  if (!solverAdmitted) fail(`[${profile}] cert-manager HTTP-01 solver pods are not reachable from the ingress controller on :8089`);

  const opa = nps.find((n) => n.metadata.name === 'opa-allow-callers');
  if (opa) {
    const peers = (opa.spec.ingress ?? []).flatMap((r) => r.from ?? []).map((p) => Object.entries(p.podSelector?.matchLabels ?? {}).map(([k, v]) => `${k.replace('app.kubernetes.io/', '')}=${v}`).join(',')).sort();
    if (JSON.stringify(peers) !== JSON.stringify(OPA_PEERS)) fail(`[${profile}] opa-allow-callers admits ${peers.join(' ')}; expected exactly ${OPA_PEERS.join(' ')}`);
  }

  let checked = 0;
  // os-ui's listed observability calls (only where the target service is rendered).
  const ui = workloads.find((w) => w.d.kind === 'Deployment' && w.t.metadata?.labels?.['app.kubernetes.io/component'] === 'os-ui');
  for (const [svcName, port] of OS_UI_CALLS) {
    const svc = svcs.get(svcName);
    if (!svc || !ui) continue;
    const sp = (svc.spec.ports ?? []).find((x) => x.port === port);
    for (const tgt of workloads.filter((w) => matches({ matchLabels: svc.spec.selector }, w.t.metadata?.labels ?? {}))) {
      const tLabels = tgt.t.metadata.labels ?? {};
      const cp = (tgt.t.spec.containers ?? []).flatMap((c) => c.ports ?? []).find((p) => p.name === sp?.targetPort || p.containerPort === sp?.targetPort);
      const selecting = nps.filter((n) => matches(n.spec.podSelector, tLabels) || Object.keys(n.spec.podSelector ?? {}).length === 0);
      checked++;
      const admitted = selecting.some((n) => (n.spec.ingress ?? []).some((r) => portMatches(r.ports, cp?.containerPort ?? port, cp?.name) && (!r.from || r.from.some((p) => peerAdmits(p, ui.t.metadata.labels)))));
      if (!admitted) fail(`[${profile}] os-ui calls ${svcName}:${port} but no ingress policy admits it`);
    }
  }
  for (const svcName of COVERED) {
    const svc = svcs.get(svcName);
    if (!svc) continue;
    const targets = workloads.filter((w) => svc.spec.selector && matches({ matchLabels: svc.spec.selector }, w.t.metadata?.labels ?? {}));
    for (const tgt of targets) {
      const tLabels = tgt.t.metadata.labels ?? {};
      const selecting = nps.filter((n) => matches(n.spec.podSelector, tLabels) || Object.keys(n.spec.podSelector ?? {}).length === 0);
      if (!selecting.some((n) => n.metadata.name === 'default-deny-ingress')) fail(`[${profile}] ${tgt.d.metadata.name} is not under default-deny-ingress`);
      const containerPorts = (tgt.t.spec.containers ?? []).flatMap((c) => c.ports ?? []);
      for (const sp of svc.spec.ports ?? []) {
        const tp = sp.targetPort ?? sp.port;
        const cp = typeof tp === 'number' ? containerPorts.find((p) => p.containerPort === tp) : containerPorts.find((p) => p.name === tp);
        const portNum = typeof tp === 'number' ? tp : cp?.containerPort;
        const host = new RegExp(`(?<![\\w.-])${svcName.replace(/[-.]/g, (c) => `\\${c}`)}(?:\\.${NS}(?:\\.svc(?:\\.cluster\\.local)?)?)?:${sp.port}(?!\\d)`);
        for (const w of workloads) {
          if (w.d === tgt.d) continue;
          let txt = JSON.stringify(w.t.spec);
          for (const m of txt.matchAll(/"(?:configMap|configMapRef|configMapKeyRef)":\{[^}]*"name":"([^"]+)"/g)) txt += cms.get(m[1]) ?? '';
          for (const m of txt.matchAll(/"(?:secretRef|secretKeyRef)":\{[^}]*"name":"([^"]+)"|"secretName":"([^"]+)"/g)) txt += secrets.get(m[1] ?? m[2]) ?? '';
          // `host:port` in a URL, or a host and a port given as separate env values (TRINO_HOST/TRINO_PORT, PGHOST).
          const envHost = txt.includes(`"value":"${svcName}"`) && (txt.includes(`"value":"${sp.port}"`) || sp.port === 5432);
          const hit = host.test(txt) || envHost;
          if (!hit) continue;
          const tgtComp = tLabels['app.kubernetes.io/component'];
          const caller = w.t.metadata?.labels ?? {};
          const callerComp = caller['app.kubernetes.io/component'] ?? caller.component ?? caller['app.kubernetes.io/name'];
          if (NOT_A_CALL[`${tgtComp}->${callerComp}`] || NOT_A_CALL[`${callerComp}->${tgtComp}`]) continue;
          checked++;
          const admitted = selecting.some((n) => (n.spec.ingress ?? []).some((r) => portMatches(r.ports, portNum, cp?.name) && (!r.from || r.from.some((p) => peerAdmits(p, caller)))));
          if (!admitted) fail(`[${profile}] ${w.d.kind} ${w.d.metadata.name} calls ${svcName}:${sp.port} but no ingress policy admits it`);
        }
      }
    }
  }
  return checked;
}

const profiles = {
  local: ['-f', join(repo, 'values.local.yaml')],
  dev: ['-f', join(repo, 'values.dev.yaml')],
  stackit: ['-f', join(repo, 'values.stackit-managed.yaml')],
  // The durable Polaris metastore (production): Polaris and its bootstrap reach Postgres.
  'dev+polaris-jdbc': ['-f', join(repo, 'values.dev.yaml'), '--set', 'polaris.persistenceType=relational-jdbc'],
  // The observability stack is off on the dev node but on in production: check it under dev's policies too.
  'dev+observability': ['-f', join(repo, 'values.dev.yaml'), '--set', 'observability.enabled=true'],
};
for (const [p, args] of Object.entries(profiles)) {
  const n = analyse(p, render(...args));
  console.log(`${TAG}: [${p}] ${n} caller→service hops admitted`);
}
const off = render('-f', join(repo, 'values.dev.yaml'), '--set', 'networkPolicies.platformIngress.enabled=false');
const leaked = off.filter((d) => d.kind === 'NetworkPolicy' && POLICIES.includes(d.metadata.name));
if (leaked.length) fail(`platformIngress.enabled=false still renders ${leaked.map((d) => d.metadata.name).join(', ')}`);

if (failures.length) {
  for (const f of failures) console.error(`${TAG}: FAIL ${f}`);
  process.exit(1);
}
console.log(`${TAG}: OK`);
