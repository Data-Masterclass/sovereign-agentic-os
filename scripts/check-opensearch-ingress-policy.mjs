#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    OpenSearch: restrict ingress to the OS components that use it (defence in depth)
 * USER STORY: As an operator I want CI to fail when the OpenSearch ingress policy stops rendering,
 *             stops selecting the OpenSearch pods, or no longer admits a component that calls
 *             OpenSearch — a missed client is a broken product (its requests time out), and a
 *             policy that selects nothing protects nothing.
 * ARCHITECTURE:
 *   - Renders the chart and asserts, on the RENDERED manifests:
 *     (1) the default install renders `opensearch-allow-os-clients-only`, Ingress-only;
 *     (2) its podSelector matches the labels of the rendered OpenSearch StatefulSet's pods;
 *     (3) :9200 admits EXACTLY the expected component selectors (os-ui, os-ui-worker,
 *         opensearch-snapshot-register, opensearch-snapshot-cron, opensearch-maintenance,
 *         restore-drill);
 *     (4) :9300 is admitted between OpenSearch pods;
 *     (5) every rendered workload that references the in-cluster OpenSearch URL carries a
 *         component label the policy admits (worker + snapshots switched on so they render);
 *     (6) `networkPolicies.opensearchIngress=false` and `opensearch.enabled=false` render none.
 *   - Same skip rules as check-worker-env.mjs: loud skip on a laptop without helm / subcharts,
 *     hard failure in CI. No YAML parser: it splits the manifest stream and matches lines.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');
const POLICY = 'opensearch-allow-os-clients-only';
const EXPECTED_REST_PEERS = ['opensearch-maintenance', 'opensearch-snapshot-cron', 'opensearch-snapshot-register', 'os-ui', 'os-ui-worker', 'restore-drill'];
const TAG = 'check-opensearch-ingress-policy';

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
  execFileSync('helm', ['template', 'agentic-os', CHART, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const docs = (text) => text.split(/^---$/m);
const kindOf = (doc) => doc.match(/^kind: (\S+)$/m)?.[1];
const nameOf = (doc) => doc.match(/^metadata:\n(?:.*\n)*?\s{2}name: (\S+)$/m)?.[1];
const findPolicy = (text) => docs(text).find((d) => kindOf(d) === 'NetworkPolicy' && nameOf(d) === POLICY);

/** `matchLabels` blocks in order: [{key: value}, …] (one entry per podSelector). */
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

/** Split the policy's `ingress:` list into rules: { peers: [labels…], ports: [n…] }. */
function ingressRules(policy) {
  const body = policy.slice(policy.indexOf('\n  ingress:\n'));
  return body
    .split(/^\s{4}- from:\n/m)
    .slice(1)
    .map((rule) => ({
      peers: matchLabelBlocks(rule),
      ports: [...rule.matchAll(/port: (\d+)/g)].map((m) => Number(m[1])),
    }));
}

if (!helmAvailable()) skip('helm not on PATH');
if (!existsSync(VALUES)) skip(`${VALUES} missing`);
if (!subchartsPresent()) skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

const problems = [];

// (1)–(4) on the DEFAULT render (chart values only): the flag must be on by default.
const def = render();
const policy = findPolicy(def);
if (!policy) {
  problems.push(`${POLICY} is not rendered on a DEFAULT install — networkPolicies.opensearchIngress must default to true`);
} else {
  if (!/policyTypes:\n\s+- Ingress\n/.test(policy)) problems.push(`${POLICY}: policyTypes must be [Ingress]`);
  if (/^\s+- Egress$/m.test(policy)) problems.push(`${POLICY}: must not carry Egress (egress is owned by egress-policies.yaml)`);

  const selector = matchLabelBlocks(policy.slice(policy.indexOf('podSelector:'), policy.indexOf('policyTypes:')))[0] ?? {};
  const sts = docs(def).find((d) => kindOf(d) === 'StatefulSet' && /opensearch/.test(nameOf(d) ?? ''));
  if (!sts) problems.push('the OpenSearch StatefulSet is not rendered on a DEFAULT install');
  else {
    const tpl = sts.slice(sts.indexOf('\n  template:\n'));
    const podLabels = {};
    const labelsBlock = tpl.match(/\n {4}metadata:\n(?: {6}\S.*\n)*? {6}labels:\n((?: {8}\S.*\n)+)/)?.[1] ?? '';
    for (const l of labelsBlock.matchAll(/^\s+([\w./-]+): "?([^"\n]+?)"?\s*$/gm)) podLabels[l[1]] = l[2];
    if (!Object.keys(selector).length) problems.push(`${POLICY}: empty podSelector would select every pod`);
    for (const [k, v] of Object.entries(selector)) {
      if (podLabels[k] !== v) problems.push(`${POLICY}: podSelector ${k}=${v} does not match the OpenSearch pod label (${podLabels[k] ?? 'absent'})`);
    }
  }

  const rules = ingressRules(policy);
  const rest = rules.filter((r) => r.ports.includes(9200) && !r.ports.includes(9300));
  const restPeers = rest.flatMap((r) => r.peers.map((p) => p['app.kubernetes.io/component'])).sort();
  if (JSON.stringify(restPeers) !== JSON.stringify(EXPECTED_REST_PEERS)) {
    problems.push(`${POLICY}: :9200 peers are [${restPeers.join(', ')}], expected [${EXPECTED_REST_PEERS.join(', ')}]`);
  }
  const transport = rules.find((r) => r.ports.includes(9300));
  if (!transport || !transport.peers.some((p) => p['app.kubernetes.io/name'] === 'opensearch')) {
    problems.push(`${POLICY}: :9300 must be admitted between OpenSearch pods`);
  }
  if (rules.some((r) => r.ports.includes(9600))) problems.push(`${POLICY}: :9600 has no consumer and must not be opened`);
  if (rules.some((r) => r.peers.length === 0 || r.ports.length === 0)) problems.push(`${POLICY}: every rule must name its peers AND its ports`);
}

// (5) No missed client: every rendered workload that points at the in-cluster OpenSearch must be
// admitted. Worker + snapshots on, so every known client renders.
{
  const full = render('-f', VALUES, '--set', 'osUI.worker.enabled=true', '--set', 'opensearchSnapshots.enabled=true', '--set', 'opensearchSnapshots.cronJob.enabled=true', '--set', 'opensearchSnapshots.s3.enabled=true', '--set', 'opensearchSnapshots.s3.bucket=ci-check', '--set', 'opensearchCleanup.enabled=true');
  const pol = findPolicy(full);
  const admitted = new Set(pol ? ingressRules(pol).flatMap((r) => r.peers.map((p) => p['app.kubernetes.io/component'])).filter(Boolean) : []);
  const seen = new Set();
  for (const d of docs(full)) {
    const kind = kindOf(d);
    if (!['Deployment', 'StatefulSet', 'Job', 'CronJob', 'DaemonSet'].includes(kind)) continue;
    if (!/\bhttps?:\/\/opensearch(?:[.:/"]|$)/m.test(d)) continue;
    const name = nameOf(d);
    if (kind === 'StatefulSet' && /^opensearch/.test(name)) continue; // OpenSearch itself
    const comps = [...d.matchAll(/app\.kubernetes\.io\/component: "?([\w-]+)"?/g)].map((m) => m[1]);
    seen.add(`${kind}/${name}`);
    if (!comps.some((c) => admitted.has(c))) {
      problems.push(`${kind}/${name} references the OpenSearch URL but its component label [${comps.join(', ') || 'none'}] is not admitted by ${POLICY}`);
    }
  }
  for (const must of ['Deployment/os-ui', 'Deployment/os-ui-worker', 'Job/register-opensearch-snapshot-repo', 'CronJob/opensearch-snapshot', 'Job/register-opensearch-s3-repo', 'Job/opensearch-orphan-cleanup']) {
    if (!seen.has(must)) problems.push(`expected OpenSearch client ${must} was not found in the render — update this check if it moved`);
  }
}

// (6) The switches.
if (findPolicy(render('--set', 'networkPolicies.opensearchIngress=false'))) {
  problems.push(`${POLICY} still renders with networkPolicies.opensearchIngress=false`);
}
if (findPolicy(render('--set', 'opensearch.enabled=false', '--set', 'opensearch.external.host=search.example.invalid'))) {
  problems.push(`${POLICY} renders with opensearch.enabled=false (no bundled OpenSearch to protect)`);
}

if (problems.length) {
  console.error(`${TAG} FAILED:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${TAG}: ok — ${POLICY} renders by default, selects the OpenSearch pods, admits :9200 from [${EXPECTED_REST_PEERS.join(', ')}] and :9300 between OpenSearch pods; every rendered OpenSearch client is admitted; both switches turn it off`);
