#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Outbound HTTPS goes through the egress proxy
 * USER STORY: As an operator I want CI to fail when the API-server egress rule is not narrowed to
 *             the API server, when the model gateway stops using the egress proxy, or when a model
 *             host the gateway is configured for is missing from the proxy allowlist (its calls
 *             would fail closed in production).
 * ARCHITECTURE:
 *   - Renders the chart (local and STACKIT profiles, with `networkPolicies.apiserver.cidrs` set)
 *     with js-yaml and asserts on the rendered objects:
 *     (1) `allow-apiserver-egress` allows only the given CIDRs on 443/6443;
 *     (2) the LiteLLM Deployment sets HTTPS_PROXY to the egress proxy and NO_PROXY covers the
 *         in-cluster services it calls;
 *     (3) every https `api_base` host in the gateway's model list is on the proxy allowlist
 *         (tinyproxy filter: the host or a parent domain);
 *     (4) every direct-HTTPS exception is public 443 only (RFC1918 and the CGNAT range excluded).
 *   - Loud skip without helm / subcharts / js-yaml, hard failure in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = process.env.CHART_DIR ? resolve(process.env.CHART_DIR) : join(repo, 'charts', 'sovereign-agentic-os');
const TAG = 'check-egress-routing';
const skip = (why) => {
  if (process.env.CI) { console.error(`${TAG}: ${why} — FAILING because CI is set.`); process.exit(1); }
  console.log(`${TAG}: ${why} — SKIPPED`); process.exit(0);
};
let yaml;
try { yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml'); } catch { skip('js-yaml not installed (os-ui/node_modules)'); }
try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); } catch { skip('helm not installed'); }
const sub = join(CHART, 'charts');
if (!(existsSync(sub) && readdirSync(sub).some((f) => f.endsWith('.tgz')))) skip('subcharts not built');

const CIDR = '203.0.113.10/32';
const failures = [];
let modelsChecked = 0;
const render = (...a) => yaml.loadAll(execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', '--set', 'global.allowChartDefaultSecrets=true', '--set', `networkPolicies.apiserver.cidrs={${CIDR}}`, ...a], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })).filter(Boolean);
const IN_CLUSTER = ['agentic-os-langfuse-web', 'query-tool', 'mock-model'];

for (const [profile, args] of Object.entries({ local: ['-f', join(repo, 'values.local.yaml')], stackit: ['-f', join(repo, 'values.stackit-managed.yaml')] })) {
  const objs = render(...args);
  const fail = (m) => failures.push(`[${profile}] ${m}`);
  const api = objs.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'allow-apiserver-egress');
  if (api) {
    for (const r of api.spec.egress ?? []) {
      const to = (r.to ?? []).map((p) => p.ipBlock?.cidr);
      if (JSON.stringify(to) !== JSON.stringify([CIDR])) fail(`allow-apiserver-egress admits ${JSON.stringify(r.to ?? 'ANY destination')}, expected only ${CIDR}`);
    }
  }
  // Every "public" ipBlock (soa.network.nonPublicCidrs) leaves out private, CGNAT (Gardener/SKE pods and Services),
  // link-local (metadata), 240.0.0.0/4 (the SKE API server endpoint) and the configured API server address.
  const NON_PUBLIC = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '240.0.0.0/4', CIDR];
  const publicRules = (d) => (d.spec.egress ?? []).filter((r) => (r.to ?? []).some((p) => p.ipBlock?.cidr === '0.0.0.0/0'));
  for (const d of objs.filter((o) => o.kind === 'NetworkPolicy' && o.metadata.name.startsWith('allow-direct-https-egress-'))) {
    for (const r of d.spec.egress ?? []) {
      const ports = (r.ports ?? []).map((p) => p.port);
      if (JSON.stringify(ports) !== '[443]') fail(`${d.metadata.name}: ports ${JSON.stringify(ports)}, expected [443]`);
    }
  }
  const publicPolicies = objs.filter((o) => o.kind === 'NetworkPolicy' && (o.metadata.name.startsWith('allow-direct-https-egress-') ||
    ['allow-egress-proxy-internet', 'software-scanner-egress'].includes(o.metadata.name)));
  for (const name of ['allow-egress-proxy-internet', 'software-scanner-egress']) if (!publicPolicies.some((d) => d.metadata.name === name)) fail(`${name} did not render`);
  for (const d of publicPolicies) {
    const rules = publicRules(d);
    if (!rules.length) fail(`${d.metadata.name}: no public ipBlock rule`);
    for (const r of rules) {
      const ex = r.to.find((p) => p.ipBlock?.cidr === '0.0.0.0/0').ipBlock.except ?? [];
      for (const c of NON_PUBLIC) if (!ex.includes(c)) fail(`${d.metadata.name}: ${c} not excluded`);
    }
  }
  const gw = objs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'agentic-os-litellm');
  if (gw) {
    // The gateway's proxy env comes from the `litellm-egress-env` ConfigMap (envFrom).
    const fromCms = gw.spec.template.spec.containers.flatMap((c) => c.envFrom ?? []).map((f) => f.configMapRef?.name).filter(Boolean);
    const env = Object.assign({}, ...objs.filter((d) => d.kind === 'ConfigMap' && fromCms.includes(d.metadata.name)).map((d) => d.data ?? {}),
      Object.fromEntries(gw.spec.template.spec.containers.flatMap((c) => c.env ?? []).filter((e) => 'value' in e).map((e) => [e.name, String(e.value)])));
    if (env.HTTPS_PROXY !== 'http://egress-proxy:3128') fail(`LiteLLM HTTPS_PROXY is ${env.HTTPS_PROXY ?? 'unset'}`);
    const np = (env.NO_PROXY ?? '').split(',');
    for (const h of IN_CLUSTER) if (!np.includes(h)) fail(`LiteLLM NO_PROXY misses in-cluster ${h}`);
    const cm = objs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'agentic-os-litellm-config');
    const filter = objs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'egress-proxy-config')?.data?.filter ?? '';
    const allowed = [...filter.matchAll(/\(\^\|\\\.\)(.+)\$/g)].map((m) => m[1].replace(/\\\./g, '.'));
    const cfg = cm ? yaml.load(Object.values(cm.data)[0]) : {};
    for (const m of cfg?.model_list ?? []) {
      const base = m.litellm_params?.api_base;
      if (typeof base !== 'string' || !base.startsWith('https://')) continue;
      const host = new URL(base).hostname;
      modelsChecked++;
      if (!allowed.some((a) => host === a || host.endsWith(`.${a}`))) fail(`model ${m.model_name}: ${host} is not on the egress proxy allowlist`);
    }
  }
}
if (failures.length) { for (const f of failures) console.error(`${TAG}: FAIL ${f}`); process.exit(1); }
if (modelsChecked === 0) { console.error(`${TAG}: FAIL no https model host was checked (model list not found)`); process.exit(1); }
console.log(`${TAG}: ok (${modelsChecked} model hosts) — API-server egress narrowed, direct-HTTPS exceptions public-443 only, the gateway uses the egress proxy and every https model host is allowlisted`);
