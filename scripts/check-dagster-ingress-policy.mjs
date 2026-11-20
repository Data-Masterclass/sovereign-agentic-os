#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — Dagster webserver and code-location ingress allowlists
 * USER STORY: As an operator I want CI to fail when the Dagster ingress NetworkPolicies stop
 *             selecting the Dagster pods, or stop admitting an OS component that calls Dagster,
 *             so a label change in the subchart or the OS cannot silently break the data plane
 *             or silently leave the policy selecting nothing.
 * ARCHITECTURE:
 *   - Renders the chart and parses every document (js-yaml from os-ui's dependencies).
 *   - Asserts on the default render (with `osUI.worker.enabled=true`, so its peer has a pod):
 *       1. `dagster-webserver-ingress` selects the webserver pod template and nothing else among
 *          the Dagster workloads (not the daemon, not the code server, not a launched run pod);
 *       2. `dagster-code-location-ingress` selects the code-server pod template only;
 *       3. every peer the policies name matches a rendered workload (os-ui, os-ui-worker,
 *          webserver, daemon, code server) — a typo would otherwise be a peer that admits nobody;
 *       4. the webserver callers (os-ui, os-ui-worker, the code server's repo-sync sidecar) are
 *          admitted on the webserver's container port and a launched run pod is NOT (it shares
 *          `component: user-deployments` with the code server, and carries `dagster/run-id`);
 *          the code server's gRPC port admits the webserver and the daemon ONLY (not os-ui, not
 *          a run pod, not the code server itself);
 *       5. both are Ingress-only (egress stays with egress-policies.yaml) and no ingress
 *          controller is admitted while no Dagster Ingress renders.
 *   - With `ingress.enabled` + `ingress.hosts.dagster`, the controller namespace is admitted to
 *     the webserver port (the Dagster UI keeps working through its Ingress).
 *   - `networkPolicies.dagster.enabled=false` or `dagster.enabled=false` renders neither.
 *   - SKIPS (exit 0, loudly) without helm, the subchart `.tgz` files or js-yaml; in CI
 *     (`process.env.CI`) a skip is a FAILURE, as in `check-consoles-not-public.mjs`.
 *   - Wired into `os-ui/scripts/gate.sh`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// A test render of policies with the Ingress on: it keeps the chart's published default secrets on
// purpose, which templates/base/secret-defaults-guard.yaml refuses for a real install.
const TEST_RENDER = ['--set', 'global.allowChartDefaultSecrets=true'];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const RELEASE = 'agentic-os';
const NAME = 'check-dagster-ingress-policy';
const WEB_POLICY = 'dagster-webserver-ingress';
const GRPC_POLICY = 'dagster-code-location-ingress';
const problems = [];

function finish(skipped) {
  if (problems.length) {
    console.error(`${NAME} FAILED:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (skipped) {
    if (process.env.CI) {
      console.error(`${NAME}: ${skipped} — FAILING because CI is set; a chart check may not silently skip in CI.`);
      process.exit(1);
    }
    console.log(`${NAME}: ${skipped} — checks SKIPPED`);
    process.exit(0);
  }
  console.log(`${NAME}: ok — the Dagster webserver and code-location policies select exactly their pods, admit every OS caller on the right port and nothing else, add the ingress controller only with a Dagster Ingress, and switch off with their flag`);
  process.exit(0);
}

let yaml;
try {
  yaml = createRequire(resolve(repo, 'os-ui/package.json'))('js-yaml');
} catch {
  finish('js-yaml not installed (run `npm --prefix os-ui ci`)');
}
try {
  execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
} catch {
  finish('helm not on PATH');
}
const deps = join(CHART, 'charts');
if (!existsSync(deps) || !readdirSync(deps).some((f) => f.endsWith('.tgz'))) {
  finish('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');
}

function render(args) {
  const text = execFileSync('helm', ['template', RELEASE, CHART, '-n', 'agentic-os', ...TEST_RENDER, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return yaml.loadAll(text).filter(Boolean);
}
const expr = (e, labels) => {
  const has = Object.hasOwn(labels ?? {}, e.key);
  switch (e.operator) {
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
    case 'In': return has && e.values.includes(labels[e.key]);
    case 'NotIn': return !has || !e.values.includes(labels[e.key]);
    default: throw new Error(`unknown selector operator ${e.operator}`);
  }
};
const matches = (selector, labels) =>
  !!selector && Object.keys(selector.matchLabels ?? {}).length > 0 &&
  Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels?.[k] === v) &&
  (selector.matchExpressions ?? []).every((e) => expr(e, labels));
const policy = (docs, name) => docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === name);
const workload = (docs, name) => docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === name);
const podLabels = (d) => d?.spec?.template?.metadata?.labels ?? {};
const ports = (d) => (d?.spec?.template?.spec?.containers ?? []).flatMap((c) => (c.ports ?? []).map((p) => p.containerPort));
/** Is a pod with `labels` (same namespace) admitted on `port` by `np`? */
function admits(np, labels, port) {
  return (np.spec.ingress ?? []).some((rule) =>
    (rule.from ?? []).some((peer) => peer.podSelector && !peer.namespaceSelector && matches(peer.podSelector, labels)) &&
    (rule.ports ?? []).some((p) => p.port === port));
}
const controllerPeers = (np) =>
  (np.spec.ingress ?? []).flatMap((r) => (r.from ?? []).filter((p) => p.namespaceSelector));

let docs;
try {
  // The worker is off by default; turn it on so its peer can be verified against a real pod.
  docs = render(['--set', 'osUI.worker.enabled=true']);
} catch (e) {
  problems.push(`default render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  finish(null);
}

const W = {
  web: workload(docs, `${RELEASE}-dagster-webserver`),
  daemon: workload(docs, `${RELEASE}-dagster-daemon`),
  code: docs.find((d) => d.kind === 'Deployment' && podLabels(d).component === 'user-deployments'),
  osUi: workload(docs, 'os-ui'),
  worker: workload(docs, 'os-ui-worker'),
};
for (const [k, d] of Object.entries(W)) if (!d) problems.push(`default render has no ${k} Deployment — the check cannot verify its peer`);
// A launched run pod: the run launcher's podTemplateSpecMetadata labels plus the labels dagster-k8s adds.
const runPod = {
  'app.kubernetes.io/name': 'dagster',
  'app.kubernetes.io/component': 'run_worker',
  'app.kubernetes.io/part-of': 'sovereign-os',
  component: 'user-deployments',
  'dagster/run-id': '00000000-0000-0000-0000-000000000000',
};

const web = policy(docs, WEB_POLICY);
const grpc = policy(docs, GRPC_POLICY);
if (!web) problems.push(`default render has no ${WEB_POLICY}`);
if (!grpc) problems.push(`default render has no ${GRPC_POLICY}`);
if (web && grpc && !problems.length) {
  const webPort = ports(W.web)[0];
  // The user-code container declares no containerPort (it is `dagster api grpc -p <port>`), so
  // the gRPC port is the one the code location's Service — the address the workspace dials — targets.
  const codeSvc = docs.find((d) => d.kind === 'Service' && matches({ matchLabels: d.spec?.selector ?? {} }, podLabels(W.code)));
  const grpcPort = codeSvc?.spec?.ports?.[0]?.targetPort ?? codeSvc?.spec?.ports?.[0]?.port;
  if (typeof grpcPort !== 'number') problems.push(`no numeric gRPC port on the code location's Service (${JSON.stringify(codeSvc?.spec?.ports)})`);
  for (const np of [web, grpc]) {
    if (JSON.stringify(np.spec.policyTypes) !== '["Ingress"]') problems.push(`${np.metadata.name}: policyTypes must be exactly [Ingress] (egress stays in egress-policies.yaml)`);
    if (controllerPeers(np).length) problems.push(`${np.metadata.name}: admits a namespace on the default render, where no Dagster Ingress exists`);
    for (const rule of np.spec.ingress ?? []) {
      for (const peer of rule.from ?? []) {
        if (peer.podSelector && !Object.values(W).some((d) => matches(peer.podSelector, podLabels(d)))) {
          problems.push(`${np.metadata.name}: peer ${JSON.stringify(peer.podSelector.matchLabels)} matches no rendered workload`);
        }
      }
    }
  }
  // 1/2: selection
  if (!matches(web.spec.podSelector, podLabels(W.web))) problems.push(`${WEB_POLICY} does not select the webserver pods`);
  for (const [k, labels] of [['daemon', podLabels(W.daemon)], ['code server', podLabels(W.code)], ['run pod', runPod]]) {
    if (matches(web.spec.podSelector, labels)) problems.push(`${WEB_POLICY} also selects the ${k}`);
  }
  if (!matches(grpc.spec.podSelector, podLabels(W.code))) problems.push(`${GRPC_POLICY} does not select the code-server pods`);
  for (const [k, labels] of [['webserver', podLabels(W.web)], ['daemon', podLabels(W.daemon)], ['run pod', runPod]]) {
    if (matches(grpc.spec.podSelector, labels)) problems.push(`${GRPC_POLICY} also selects the ${k}`);
  }
  // 4: callers on the right ports
  for (const [k, labels] of [['os-ui', podLabels(W.osUi)], ['os-ui-worker', podLabels(W.worker)], ['code server (repo-sync)', podLabels(W.code)]]) {
    if (!admits(web, labels, webPort)) problems.push(`${WEB_POLICY} does not admit ${k} on ${webPort}`);
  }
  if (admits(web, runPod, webPort)) problems.push(`${WEB_POLICY} admits launched run pods, which make no webserver call — select the code server by name too`);
  if (admits(web, podLabels(W.daemon), webPort)) problems.push(`${WEB_POLICY} admits the daemon, which does not call the webserver`);
  for (const [k, labels] of [['webserver', podLabels(W.web)], ['daemon', podLabels(W.daemon)]]) {
    if (!admits(grpc, labels, grpcPort)) problems.push(`${GRPC_POLICY} does not admit ${k} on gRPC ${grpcPort}`);
  }
  for (const [k, labels] of [['os-ui', podLabels(W.osUi)], ['os-ui-worker', podLabels(W.worker)], ['run pod', runPod], ['code server', podLabels(W.code)]]) {
    if (admits(grpc, labels, grpcPort)) problems.push(`${GRPC_POLICY} admits ${k} on gRPC ${grpcPort}`);
  }
}

// With a Dagster Ingress: the controller namespace reaches the webserver port, and only that.
try {
  const d = render(['--set', 'ingress.enabled=true', '--set', 'ingress.hosts.dagster=dagster.example.test']);
  const np = policy(d, WEB_POLICY);
  const peers = np ? controllerPeers(np) : [];
  if (peers.length !== 1 || peers[0].namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] !== 'ingress-nginx') {
    problems.push(`ingress.hosts.dagster set: ${WEB_POLICY} must admit exactly the ingress-nginx namespace (found ${JSON.stringify(peers)})`);
  }
  if (policy(d, GRPC_POLICY) && controllerPeers(policy(d, GRPC_POLICY)).length) problems.push(`ingress.hosts.dagster set: ${GRPC_POLICY} must not admit the ingress controller`);
  const noHost = policy(render(['--set', 'ingress.enabled=true']), WEB_POLICY);
  if (noHost && controllerPeers(noHost).length) problems.push(`ingress.enabled without a Dagster host: ${WEB_POLICY} must not admit the ingress controller`);
} catch (e) {
  problems.push(`ingress render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
}

// The flag and the component switch.
for (const args of [['--set', 'networkPolicies.dagster.enabled=false'], ['--set', 'dagster.enabled=false']]) {
  try {
    const d = render(args);
    if (policy(d, WEB_POLICY) || policy(d, GRPC_POLICY)) problems.push(`${args[1]}: the Dagster ingress policies still render`);
  } catch (e) {
    problems.push(`${args[1]}: render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}
finish(null);
