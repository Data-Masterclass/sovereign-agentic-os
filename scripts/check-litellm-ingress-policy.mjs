#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    LiteLLM: restrict ingress to OS components (defence in depth)
 * USER STORY: As an operator I want CI to fail when the LiteLLM ingress policy stops rendering,
 *             stops selecting the gateway pods, admits a component that does not call the
 *             gateway, or no longer admits one that does — a missed caller is a broken product
 *             (its model calls time out), an extra one is a wider door than needed.
 * ARCHITECTURE:
 *   - Renders the chart and asserts, on the RENDERED manifests:
 *     (1) the default install renders `litellm-allow-os-clients-only`, Ingress-only;
 *     (2) its podSelector matches the pod labels of the rendered LiteLLM proxy Deployment;
 *     (3) the proxy port admits EXACTLY the expected peers (components os-ui, os-ui-worker,
 *         litellm-key-init, plus the gateway's own pods for the upstream `helm test` pod) and
 *         no namespaceSelector;
 *     (4) every rendered workload whose spec names the LiteLLM Service or sets LITELLM_URL carries
 *         a label the policy admits (worker switched on so it renders);
 *     (5) the ingress-controller namespace is admitted ONLY when the restricted LiteLLM Ingress
 *         renders (ingress.restricted.litellm.expose with a protection annotation);
 *     (6) `networkPolicies.litellmIngress=false` and `litellm.enabled=false` render none.
 *   - CHART_DIR overrides the chart path, so scripts/tests/litellm-ingress-policy.test.sh can run
 *     this check against a deliberately broken copy (the negative twin).
 *   - Same skip rules as check-opensearch-ingress-policy.mjs: loud skip on a laptop without helm /
 *     subcharts, hard failure in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = process.env.CHART_DIR ? resolve(process.env.CHART_DIR) : join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');
const POLICY = 'litellm-allow-os-clients-only';
const PORT = 4000;
const EXPECTED_PEERS = ['component=litellm-key-init', 'component=os-ui', 'component=os-ui-worker', 'name=litellm'];
const TAG = 'check-litellm-ingress-policy';

function skip(why) {
  if (process.env.CI) {
    console.error(`${TAG}: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`${TAG}: ${why} — SKIPPED`);
  process.exit(0);
}
function helmAvailable() {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const subchartsPresent = () => {
  const dir = join(CHART, 'charts');
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.tgz'));
};

const render = (...args) =>
  execFileSync('helm', ['template', 'agentic-os', CHART, '--skip-schema-validation', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const docs = (text) => text.split(/^---$/m);
const kindOf = (doc) => doc.match(/^kind: (\S+)$/m)?.[1];
const nameOf = (doc) => doc.match(/^metadata:\n(?:.*\n)*?\s{2}name: "?([^"\s]+)"?$/m)?.[1];
const findPolicy = (text) => docs(text).find((d) => kindOf(d) === 'NetworkPolicy' && nameOf(d) === POLICY);

/** `matchLabels` blocks in order: [{key: value}, …] (one entry per selector). */
function matchLabelBlocks(text) {
  const out = [];
  const re = /^(\s*)matchLabels:\n((?:\1\s+\S.*\n?)+)/gm;
  for (const m of text.matchAll(re)) {
    const labels = {};
    for (const l of m[2].matchAll(/^\s+([\w./-]+): "?([^"\n]+?)"?\s*$/gm)) labels[l[1]] = l[2];
    out.push(labels);
  }
  return out;
}
/** The policy's `ingress:` rules: { pods: [labels…], namespaces: [labels…], ports: [n…] }. */
function ingressRules(policy) {
  const body = policy.slice(policy.indexOf('\n  ingress:\n'));
  return body
    .split(/^\s{4}- from:\n/m)
    .slice(1)
    .map((rule) => {
      const pods = [];
      const namespaces = [];
      for (const peer of rule.split(/^\s{8}- /m).slice(1)) {
        const labels = matchLabelBlocks(peer)[0] ?? {};
        if (/^namespaceSelector:/.test(peer)) namespaces.push(labels);
        else if (/^podSelector:/.test(peer)) pods.push(labels);
      }
      return { pods, namespaces, ports: [...rule.matchAll(/port: (\d+)/g)].map((m) => Number(m[1])) };
    });
}
/** A peer selector as one comparable token. */
function peerToken(labels) {
  if (labels['app.kubernetes.io/component']) return `component=${labels['app.kubernetes.io/component']}`;
  if (labels['app.kubernetes.io/name']) return `name=${labels['app.kubernetes.io/name']}`;
  return `other=${JSON.stringify(labels)}`;
}
/** Pod-template labels of a workload document (the first `labels:` under `template: metadata:`). */
function podLabels(doc) {
  const lines = doc.slice(doc.indexOf('\n  template:\n')).split('\n');
  const out = {};
  const meta = lines.findIndex((l) => /^\s+metadata:$/.test(l));
  if (meta < 0) return out;
  const metaIndent = lines[meta].search(/\S/);
  for (let i = meta + 1; i < lines.length; i++) {
    const ind = lines[i].search(/\S/);
    if (ind <= metaIndent) break;
    if (ind === metaIndent + 2 && /^\s+labels:$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^(\s+)([\w./-]+): "?([^"\n]+?)"?\s*$/);
        if (!m || m[1].length <= ind) break;
        out[m[2]] = m[3];
      }
      break;
    }
  }
  return out;
}
const admits = (selector, labels) => Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels[k] === v);

if (!helmAvailable()) skip('helm not on PATH');
if (!existsSync(VALUES)) skip(`${VALUES} missing`);
if (!subchartsPresent()) skip(`no subchart .tgz in ${join(CHART, 'charts')} (run \`helm dependency build charts/sovereign-agentic-os\`)`);

const problems = [];

// (1)–(3) on the DEFAULT render: the flag must be on by default.
const def = render();
const policy = findPolicy(def);
if (!policy) {
  problems.push(`${POLICY} is not rendered on a DEFAULT install — networkPolicies.litellmIngress must default to true`);
} else {
  if (!/policyTypes:\n\s+- Ingress\n/.test(policy)) problems.push(`${POLICY}: policyTypes must be [Ingress]`);
  if (/^\s+- Egress$/m.test(policy)) problems.push(`${POLICY}: must not carry Egress (egress is owned by egress-policies.yaml)`);

  const selector = matchLabelBlocks(policy.slice(policy.indexOf('podSelector:'), policy.indexOf('policyTypes:')))[0] ?? {};
  const proxy = docs(def).find((d) => kindOf(d) === 'Deployment' && nameOf(d) === 'agentic-os-litellm');
  if (!proxy) problems.push('the LiteLLM proxy Deployment (agentic-os-litellm) is not rendered on a DEFAULT install');
  else if (!admits(selector, podLabels(proxy))) {
    problems.push(`${POLICY}: podSelector ${JSON.stringify(selector)} does not select the LiteLLM proxy pods ${JSON.stringify(podLabels(proxy))}`);
  }
  // It must not select an OS component that is not the gateway.
  for (const d of docs(def)) {
    if (!['Deployment', 'StatefulSet'].includes(kindOf(d)) || nameOf(d) === 'agentic-os-litellm') continue;
    if (admits(selector, podLabels(d))) problems.push(`${POLICY}: podSelector also selects ${kindOf(d)}/${nameOf(d)}`);
  }

  const rules = ingressRules(policy);
  if (rules.some((r) => r.ports.length === 0 || (r.pods.length === 0 && r.namespaces.length === 0))) {
    problems.push(`${POLICY}: every rule must name its peers AND its ports`);
  }
  if (rules.some((r) => r.ports.some((p) => p !== PORT))) problems.push(`${POLICY}: only :${PORT} may be opened`);
  const peers = rules.flatMap((r) => r.pods.map(peerToken)).sort();
  if (JSON.stringify(peers) !== JSON.stringify(EXPECTED_PEERS)) {
    problems.push(`${POLICY}: :${PORT} peers are [${peers.join(', ')}], expected [${EXPECTED_PEERS.join(', ')}]`);
  }
  if (rules.some((r) => r.namespaces.length > 0)) {
    problems.push(`${POLICY}: a DEFAULT install must admit no namespaceSelector (no other namespace calls the gateway)`);
  }
}

// (4) No missed caller: every rendered workload that points at the gateway must be admitted.
{
  const full = render('-f', VALUES, '--set', 'osUI.worker.enabled=true');
  const pol = findPolicy(full);
  const selectors = pol ? ingressRules(pol).flatMap((r) => r.pods) : [];
  const seen = new Set();
  for (const d of docs(full)) {
    const kind = kindOf(d);
    if (!['Deployment', 'StatefulSet', 'Job', 'CronJob', 'DaemonSet'].includes(kind)) continue;
    if (!/agentic-os-litellm:\d+|name: LITELLM_URL\b/.test(d)) continue;
    const name = nameOf(d);
    if (name === 'agentic-os-litellm') continue; // the gateway itself
    seen.add(`${kind}/${name}`);
    const labels = podLabels(d);
    if (!selectors.some((s) => admits(s, labels))) {
      problems.push(`${kind}/${name} calls the LiteLLM Service but its pod labels ${JSON.stringify(labels)} are not admitted by ${POLICY}`);
    }
  }
  for (const must of ['Deployment/os-ui', 'Deployment/os-ui-worker', 'Job/litellm-agent-key-init']) {
    if (!seen.has(must)) problems.push(`expected LiteLLM caller ${must} was not found in the render — update this check if it moved`);
  }
}

// (5) The ingress controller only with the restricted, protected console route.
{
  const hostOnly = findPolicy(render('--set', 'ingress.enabled=true', '--set', 'ingress.hosts.litellm=gw.example.invalid'));
  if (hostOnly && /namespaceSelector:/.test(hostOnly)) {
    problems.push(`${POLICY}: a bare ingress.hosts.litellm (no restricted opt-in) must not admit the ingress controller`);
  }
  const exposed = findPolicy(render(
    '--set', 'ingress.enabled=true', '--set', 'ingress.hosts.litellm=gw.example.invalid',
    '--set', 'ingress.restricted.litellm.expose=true',
    '--set-string', 'ingress.restricted.litellm.annotations.nginx\\.ingress\\.kubernetes\\.io/whitelist-source-range=10.0.0.0/8',
  ));
  const ns = exposed ? ingressRules(exposed).flatMap((r) => r.namespaces) : [];
  if (!ns.some((l) => l['kubernetes.io/metadata.name'] === 'ingress-nginx')) {
    problems.push(`${POLICY}: the restricted LiteLLM Ingress renders but the ingress-nginx namespace is not admitted`);
  }
}

// (6) The switches.
if (findPolicy(render('--set', 'networkPolicies.litellmIngress=false'))) {
  problems.push(`${POLICY} still renders with networkPolicies.litellmIngress=false`);
}
if (findPolicy(render('--set', 'litellm.enabled=false', '--set', 'litellmAgentKey.enabled=false'))) {
  problems.push(`${POLICY} renders with litellm.enabled=false (no gateway to protect)`);
}

if (problems.length) {
  console.error(`${TAG} FAILED:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${TAG}: ok — ${POLICY} renders by default, selects only the LiteLLM pods, admits :${PORT} from [${EXPECTED_PEERS.join(', ')}]; every rendered caller is admitted; the ingress controller only with the restricted console route; both switches turn it off`);
