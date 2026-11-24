#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — Dagster behind the OS at /tools/dagster: path prefix, read-only
 *             webserver, every in-cluster GraphQL address, and who may reach the read-only pod
 * USER STORY: As an operator I want CI to fail when the Dagster webserver runs under
 *             `/tools/dagster` but a caller still dials the old root address (repo-sync, os-ui, a
 *             values overlay), when the read-only webserver the OS proxy targets disappears, or
 *             when anything but os-ui can reach it — so the console behind the OS sign-in never
 *             silently breaks the data plane and is never reachable around the sign-in.
 * ARCHITECTURE:
 *   - Renders the chart per profile (default, values.dev.yaml, values.stackit-managed.yaml, and
 *     the two Dagster overlays at the repo root) and parses every document (js-yaml from os-ui).
 *   - Asserts, per profile:
 *       1. the editable webserver runs `--path-prefix <prefix>` and not `--read-only`; the
 *          read-only Deployment + Service exist and run `--read-only --path-prefix <prefix>`;
 *          both readiness probes hit `<prefix>/server_info`;
 *       2. os-ui gets DAGSTER_URL = http://agentic-os-dagster-webserver:80<prefix> and
 *          DAGSTER_READONLY_URL = the read-only Service origin;
 *       3. EVERY `http://agentic-os-dagster-webserver:80…` string anywhere in the render (env,
 *          ConfigMaps, the run launcher's config) carries the prefix — a root `/graphql` 404s;
 *       4. `dagster-webserver-read-only-ingress` selects only the read-only pod and admits os-ui
 *          only (not the worker, not the code server, no namespace); the code-location policy
 *          admits the read-only webserver on gRPC (it loads the workspace too).
 *   - The prefix is the one os-ui's proxy registry uses (core/infra/tool-proxy.ts `basePath` and
 *     `upstreamRootPath` of `dagster`): a drift between chart and registry fails here.
 *   - NO SIDE DOOR: a `hosts.dagster` value renders only a 308 to <OS>/tools/dagster/ (backend
 *     os-ui, no basic-auth Secret), nothing without osUI.publicUrl, and no Ingress in any render
 *     routes to a Dagster webserver.
 *   - SKIPS (exit 0, loudly) without helm, the subchart `.tgz` files or js-yaml; in CI a skip is a
 *     FAILURE. Wired into `os-ui/scripts/gate.sh`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Default secrets are kept on purpose for a test render (secret-defaults-guard.yaml refuses them for a
// real install); schema validation is skipped exactly as scripts/deploy.sh does (the Dagster subchart's
// schema $ref's a remote document and refuses the k8sRunLauncher block of values.dev.yaml).
const TEST_RENDER = ['--set', 'global.allowChartDefaultSecrets=true', '--skip-schema-validation'];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const RELEASE = 'agentic-os';
const NAME = 'check-dagster-path-prefix';
const RO_POLICY = 'dagster-webserver-read-only-ingress';
const GRPC_POLICY = 'dagster-code-location-ingress';
const WEB = `${RELEASE}-dagster-webserver`;
const RO = `${RELEASE}-dagster-webserver-read-only`;
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
  console.log(`${NAME}: ok — Dagster runs under the registry's prefix in every profile, the read-only webserver exists and only os-ui may reach it, and every in-cluster Dagster address carries the prefix`);
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

// The prefix os-ui's proxy forwards (registry entry `dagster`).
const registry = readFileSync(join(repo, 'os-ui/core/infra/tool-proxy.ts'), 'utf8');
const entry = registry.slice(registry.indexOf('  dagster: {'), registry.indexOf('},', registry.indexOf('  dagster: {')));
const PREFIX = /basePath: '([^']+)'/.exec(entry)?.[1];
const ROOT = /upstreamRootPath: '([^']+)'/.exec(entry)?.[1];
if (!PREFIX || PREFIX !== ROOT) {
  problems.push(`os-ui registry: dagster must forward its prefix (basePath ${PREFIX} vs upstreamRootPath ${ROOT})`);
  finish(null);
}

function renderText(args) {
  return execFileSync('helm', ['template', RELEASE, CHART, '-n', 'agentic-os', ...TEST_RENDER, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const matches = (selector, labels) =>
  !!selector && Object.keys(selector.matchLabels ?? {}).length > 0 &&
  Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels?.[k] === v) &&
  (selector.matchExpressions ?? []).every((e) => (e.operator === 'DoesNotExist' ? !Object.hasOwn(labels ?? {}, e.key) : true));
const podLabels = (d) => d?.spec?.template?.metadata?.labels ?? {};
const containers = (d) => d?.spec?.template?.spec?.containers ?? [];
const commandOf = (d) => containers(d).map((c) => [...(c.command ?? []), ...(c.args ?? [])].join(' ')).join(' ');
const envOf = (d, name) => containers(d).flatMap((c) => c.env ?? []).find((e) => e.name === name)?.value;
function admits(np, labels, port) {
  return (np.spec.ingress ?? []).some((rule) =>
    (rule.from ?? []).some((peer) => peer.podSelector && !peer.namespaceSelector && matches(peer.podSelector, labels)) &&
    (rule.ports ?? []).some((p) => p.port === port));
}

/** 2: os-ui's two Dagster addresses; 3: every `http://<webserver>:80…` string carries the prefix. */
function checkAddresses(label, text, osUi, runsDagster) {
  if (osUi) {
    const want = `http://${WEB}:80${PREFIX}`;
    if (envOf(osUi, 'DAGSTER_URL') !== want) problems.push(`${label}: os-ui DAGSTER_URL is ${envOf(osUi, 'DAGSTER_URL')}, not ${want}`);
    // Without a read-only webserver the console must say "not set up", never proxy to nothing.
    const ro = runsDagster ? `http://${RO}:80` : '';
    if (envOf(osUi, 'DAGSTER_READONLY_URL') !== ro) problems.push(`${label}: os-ui DAGSTER_READONLY_URL is ${JSON.stringify(envOf(osUi, 'DAGSTER_READONLY_URL'))}, not ${JSON.stringify(ro)}`);
  } else {
    problems.push(`${label}: no os-ui Deployment`);
  }
  for (const m of text.matchAll(new RegExp(`http://${WEB}:80(/[^"'\\s]*)?`, 'g'))) {
    const path = m[1] ?? '';
    if (!(path === PREFIX || path.startsWith(`${PREFIX}/`))) problems.push(`${label}: "${m[0]}" lacks the ${PREFIX} prefix (that address 404s once the webserver runs under it)`);
  }
}

// [label, helm args, does this profile run Dagster?] — the STACKIT profile switches Dagster off;
// its os-ui addresses and every rendered string are still checked.
const PROFILES = [
  ['default', ['--set', 'osUI.worker.enabled=true'], true],
  ['values.dev.yaml', ['-f', join(repo, 'values.dev.yaml'), '--set', 'osUI.worker.enabled=true'], true],
  ['values.stackit-managed.yaml', ['-f', join(repo, 'values.stackit-managed.yaml')], false],
  ['+ values.dagster-launcher-lockdown.yaml', ['-f', join(repo, 'values.dagster-launcher-lockdown.yaml')], true],
  // The run-identity overlay is applied on top of the lock-down, in that order (its header).
  // The governance store it turns on needs its bootstrap Secret NAMED (a test value here).
  ['+ lockdown + values.dagster-run-identity.yaml', ['-f', join(repo, 'values.dagster-launcher-lockdown.yaml'), '-f', join(repo, 'values.dagster-run-identity.yaml'), '--set', 'postgres.governance.adminSecretName=pg-superuser-test'], true],
];

for (const [label, args, runsDagster] of PROFILES) {
  let text;
  try {
    text = renderText(args);
  } catch (e) {
    problems.push(`${label}: render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    continue;
  }
  const docs = yaml.loadAll(text).filter(Boolean);
  const dep = (name) => docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === name);
  const web = dep(WEB);
  const ro = dep(RO);
  const osUi = dep('os-ui');
  if (!runsDagster) {
    if (web || ro) problems.push(`${label}: expected Dagster off in this profile — update this check`);
    checkAddresses(label, text, osUi, runsDagster);
    continue;
  }
  if (!web) { problems.push(`${label}: no ${WEB} Deployment`); continue; }
  if (!ro) { problems.push(`${label}: no ${RO} Deployment — the /tools/dagster console has no read-only upstream (dagster.dagsterWebserver.enableReadOnly)`); continue; }

  // 1. prefix + read-only
  if (!commandOf(web).includes(`--path-prefix ${PREFIX}`)) problems.push(`${label}: ${WEB} does not run --path-prefix ${PREFIX}`);
  if (commandOf(web).includes('--read-only')) problems.push(`${label}: ${WEB} must stay the editable webserver (os-ui launches runs through it)`);
  if (!commandOf(ro).includes('--read-only')) problems.push(`${label}: ${RO} does not run --read-only`);
  if (!commandOf(ro).includes(`--path-prefix ${PREFIX}`)) problems.push(`${label}: ${RO} does not run --path-prefix ${PREFIX}`);
  for (const d of [web, ro]) {
    const probe = containers(d)[0]?.readinessProbe?.httpGet?.path;
    if (probe !== `${PREFIX}/server_info`) problems.push(`${label}: ${d.metadata.name} readiness probe is ${probe}, not ${PREFIX}/server_info (it would never turn Ready)`);
  }
  if (!docs.some((d) => d.kind === 'Service' && d.metadata?.name === RO)) problems.push(`${label}: no ${RO} Service`);

  // 2 + 3. os-ui's addresses and every in-cluster address of the editable webserver
  checkAddresses(label, text, osUi, runsDagster);

  // 4. who reaches the read-only pod
  const np = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === RO_POLICY);
  if (!np) {
    problems.push(`${label}: no ${RO_POLICY} NetworkPolicy`);
    continue;
  }
  const roPort = containers(ro)[0]?.ports?.[0]?.containerPort;
  if (!matches(np.spec.podSelector, podLabels(ro))) problems.push(`${label}: ${RO_POLICY} does not select the read-only pod`);
  if (matches(np.spec.podSelector, podLabels(web))) problems.push(`${label}: ${RO_POLICY} also selects the editable webserver`);
  if (JSON.stringify(np.spec.policyTypes) !== '["Ingress"]') problems.push(`${label}: ${RO_POLICY} must be Ingress-only`);
  if (!admits(np, podLabels(osUi), roPort)) problems.push(`${label}: ${RO_POLICY} does not admit os-ui on ${roPort}`);
  const worker = dep('os-ui-worker');
  const code = docs.find((d) => d.kind === 'Deployment' && podLabels(d).component === 'user-deployments');
  for (const [k, d] of [['os-ui-worker', worker], ['code server', code], ['editable webserver', web]]) {
    if (d && admits(np, podLabels(d), roPort)) problems.push(`${label}: ${RO_POLICY} admits the ${k}; only os-ui (the proxy) may reach the read-only console`);
  }
  if ((np.spec.ingress ?? []).some((r) => (r.from ?? []).some((p) => p.namespaceSelector))) problems.push(`${label}: ${RO_POLICY} admits a namespace (an ingress controller would bypass the OS sign-in)`);
  const grpc = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === GRPC_POLICY);
  if (grpc && code) {
    const codeSvc = docs.find((d) => d.kind === 'Service' && matches({ matchLabels: d.spec?.selector ?? {} }, podLabels(code)));
    const grpcPort = codeSvc?.spec?.ports?.[0]?.targetPort ?? codeSvc?.spec?.ports?.[0]?.port;
    if (!admits(grpc, podLabels(ro), grpcPort)) problems.push(`${label}: ${GRPC_POLICY} does not admit the read-only webserver on gRPC ${grpcPort} (it cannot load the workspace)`);
  }
}

// NO SIDE DOOR: `hosts.dagster` is a pure 308 to <OS>/tools/dagster/ whose backend is NOT Dagster;
// without osUI.publicUrl it renders nothing; and no Ingress anywhere routes to a Dagster webserver.
try {
  const HOST = ['--set', 'ingress.enabled=true', '--set', 'ingress.hosts.dagster=dagster.example.test'];
  const withPub = yaml.loadAll(renderText([...HOST, '--set', 'osUI.publicUrl=https://os.example.test'])).filter(Boolean);
  const ing = withPub.find((d) => d.kind === 'Ingress' && (d.spec?.rules ?? []).some((r) => r.host === 'dagster.example.test'));
  if (!ing) {
    problems.push('ingress.hosts.dagster + osUI.publicUrl: no redirect Ingress rendered (old links would 404)');
  } else {
    const a = ing.metadata?.annotations ?? {};
    if (a['nginx.ingress.kubernetes.io/permanent-redirect'] !== `https://os.example.test${PREFIX}/`) problems.push(`the Dagster host must 308 to <OS>${PREFIX}/ (found ${a['nginx.ingress.kubernetes.io/permanent-redirect']})`);
    if (a['nginx.ingress.kubernetes.io/permanent-redirect-code'] !== '308') problems.push('the Dagster host redirect must be a 308');
    if (Object.keys(a).some((k) => /auth-(type|secret|url)/.test(k))) problems.push('the Dagster host must not depend on a basic-auth Secret any more');
  }
  const noPub = yaml.loadAll(renderText(HOST)).filter(Boolean);
  if (noPub.some((d) => d.kind === 'Ingress' && (d.spec?.rules ?? []).some((r) => r.host === 'dagster.example.test'))) {
    problems.push('ingress.hosts.dagster without osUI.publicUrl: an Ingress rendered, but there is nothing to redirect to');
  }
  for (const docs of [withPub, noPub]) {
    for (const d of docs.filter((x) => x.kind === 'Ingress')) {
      for (const r of d.spec?.rules ?? []) {
        for (const p of r.http?.paths ?? []) {
          const svc = p.backend?.service?.name ?? '';
          if (svc.includes('dagster')) problems.push(`Ingress ${d.metadata.name} routes to ${svc}: Dagster must never be reachable without the OS sign-in`);
        }
      }
    }
  }
} catch (e) {
  problems.push(`ingress render failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
}

finish(null);
