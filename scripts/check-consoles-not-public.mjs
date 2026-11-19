#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — the model gateway (LiteLLM) and Langfuse have no public route
 * USER STORY: As a security reviewer I want CI to fail the moment a values or template change
 *             publishes either console again. LiteLLM holds the provider credentials and an
 *             admin API; Langfuse holds every prompt, completion and tool result of every run.
 *             For 143 days production answered the internet on both hostnames with nothing in
 *             front of them but each tool's own login.
 * ARCHITECTURE:
 *   - Renders the chart and inspects every RENDERED `Ingress`: one whose backend Service is a
 *     restricted console (`<release>-litellm`, `<release>-langfuse-web`) is a public route,
 *     whichever template or subchart made it — so this also catches the subcharts' own
 *     `litellm.ingress.enabled` and `langfuse.langfuse.ingress.enabled`.
 *   - Asserts, per console:
 *       1. default values                                   → no Ingress;
 *       2. `values.stackit-managed.yaml` over the default   → no Ingress;
 *       3. STACKIT + `ingress.hosts.<key>` set (the old production state, and what a release
 *          whose values still carry the hostname deploys)   → STILL no Ingress, and the OS's
 *          console URL for Langfuse renders EMPTY (so no link points at the removed host);
 *       4. STACKIT + host + `ingress.restricted.<key>.expose=true` with NO protection
 *          annotation                                       → the render FAILS;
 *       5. the same with `whitelist-source-range`           → exactly one Ingress, and it
 *          carries the annotation. This is the control: it proves the detector can see the
 *          route, so 1-3 are not passing vacuously;
 *       6. an allowlist of 0.0.0.0/0                        → the render FAILS.
 *   - And statically (no helm needed): no committed profile sets `ingress.restricted.*.expose`,
 *     `ingress.hosts.litellm|langfuse`, or a subchart ingress. The opt-in is for a private
 *     overlay — never for a committed profile.
 *   - SKIPS the rendered half (exit 0, loudly) when `helm` is not on PATH or the subchart `.tgz`
 *     files have not been fetched; **in CI (`process.env.CI`) a skip is a hard FAILURE**, exactly
 *     as in `check-worker-env.mjs`. The static half always runs.
 *   - Wired into `os-ui/scripts/gate.sh`. docs/components/litellm.md and langfuse.md ("Not
 *     reachable from the internet") document the opt-in.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const STACKIT = join(repo, 'values.stackit-managed.yaml');
const RELEASE = 'agentic-os';
/** values key under ingress.hosts / ingress.restricted → the in-cluster Service behind it. */
const CONSOLES = { litellm: `${RELEASE}-litellm`, langfuse: `${RELEASE}-langfuse-web` };
const ALLOWLIST = 'nginx.ingress.kubernetes.io/whitelist-source-range';

const problems = [];

// ── static half ────────────────────────────────────────────────────────────────────────────
const require = createRequire(resolve(repo, 'os-ui/package.json'));
let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  // os-ui dependencies not installed (a bare checkout): the rendered half still decides.
}
if (yaml) {
  for (const [name, file] of [['charts/sovereign-agentic-os/values.yaml', join(CHART, 'values.yaml')], ['values.stackit-managed.yaml', STACKIT]]) {
    const v = yaml.load(readFileSync(file, 'utf8')) ?? {};
    for (const key of Object.keys(CONSOLES)) {
      const r = v.ingress?.restricted?.[key];
      if (r?.expose !== undefined && r.expose !== false) {
        problems.push(`${name}: ingress.restricted.${key}.expose is ${JSON.stringify(r.expose)} — a committed profile must not publish this console (use a private overlay, with a protection annotation)`);
      }
      if (v.ingress?.hosts?.[key]) {
        problems.push(`${name}: ingress.hosts.${key} is set (${JSON.stringify(v.ingress.hosts[key])}) — this console has no public hostname; remove it`);
      }
    }
    if (v.litellm?.ingress?.enabled) problems.push(`${name}: litellm.ingress.enabled is true — the subchart's own Ingress would publish the gateway`);
    if (v.langfuse?.langfuse?.ingress?.enabled) problems.push(`${name}: langfuse.langfuse.ingress.enabled is true — the subchart's own Ingress would publish Langfuse`);
  }
}

// ── rendered half ──────────────────────────────────────────────────────────────────────────
function helmAvailable() {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function subchartsPresent() {
  const dir = join(CHART, 'charts');
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.tgz'));
}
function finish(skipped) {
  if (problems.length) {
    console.error('check-consoles-not-public FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (skipped) {
    if (process.env.CI) {
      console.error(`check-consoles-not-public: ${skipped} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
      process.exit(1);
    }
    console.log(`check-consoles-not-public: ${skipped} — rendered checks SKIPPED (static checks passed; see docs/components/litellm.md)`);
    process.exit(0);
  }
  console.log('check-consoles-not-public: ok — no Ingress reaches the gateway or Langfuse on the default or the STACKIT profile, a bare hostname renders nothing and leaves the Langfuse console URL empty, an opt-in without protection fails the render, and a protected opt-in is the only way to render one');
  process.exit(0);
}

function render(args) {
  return execFileSync('helm', ['template', RELEASE, CHART, '-n', 'agentic-os', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
/** The rendered Ingress documents whose backend is `service`. */
function ingressesTo(text, service) {
  const out = [];
  for (const doc of text.split(/^---\s*$/m)) {
    if (!/^kind: Ingress\s*$/m.test(doc)) continue;
    // Strip comments so a commented-out backend cannot count either way.
    const body = doc.replace(/^\s*#.*$/gm, '');
    const backends = [...body.matchAll(/^\s+(?:name|serviceName): "?([A-Za-z0-9.-]+)"?\s*$/gm)].map((m) => m[1]);
    if (backends.includes(service)) out.push(body);
  }
  return out;
}
const nameOf = (doc) => doc.match(/^metadata:\n(?:.*\n)*?\s{2}name: "?([^\s"]+)"?\s*$/m)?.[1] ?? '(unnamed)';
/** The value of one env var in the rendered os-ui Deployment, or undefined when absent. */
function osUiEnv(text, name) {
  for (const doc of text.split(/^---\s*$/m)) {
    if (!/^kind: Deployment\s*$/m.test(doc) || !/^\s{2}name: os-ui\s*$/m.test(doc)) continue;
    const m = new RegExp(`- name: ${name}\\n\\s+value: ("[^"]*"|\\S*)`).exec(doc);
    if (m) return m[1].replace(/^"|"$/g, '');
  }
  return undefined;
}

if (!helmAvailable()) finish('helm not on PATH');
if (!subchartsPresent()) finish('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

function expectNone(label, args) {
  let text;
  try {
    text = render(args);
  } catch (e) {
    problems.push(`${label}: helm template failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    return null;
  }
  for (const [key, service] of Object.entries(CONSOLES)) {
    const got = ingressesTo(text, service);
    if (got.length) problems.push(`${label}: renders a PUBLIC route to ${key} (${got.map(nameOf).join(', ')}) — it must not be reachable from outside the cluster`);
  }
  return text;
}
function expectFail(label, args) {
  try {
    render(args);
    problems.push(`${label}: rendered, but must FAIL — an exposed console needs a real protection annotation`);
  } catch {
    // expected
  }
}

expectNone('default values', []);
expectNone('STACKIT profile', ['-f', STACKIT]);
for (const key of Object.keys(CONSOLES)) {
  const HOST = ['--set', `ingress.hosts.${key}=${key}.example.test`];
  const EXPOSE = ['--set', `ingress.restricted.${key}.expose=true`];
  const annotation = (value) => ['--set-string', `ingress.restricted.${key}.annotations.${ALLOWLIST.replace(/\./g, '\\.')}=${value}`];

  expectNone(`default + ingress.enabled + ingress.hosts.${key}, no opt-in`, ['--set', 'ingress.enabled=true', ...HOST]);
  const stale = expectNone(`STACKIT profile + ingress.hosts.${key}, no opt-in`, ['-f', STACKIT, ...HOST]);
  if (stale && key === 'langfuse') {
    const url = osUiEnv(stale, 'LANGFUSE_CONSOLE_URL');
    if (url !== '') problems.push(`STACKIT profile + ingress.hosts.langfuse, no opt-in: os-ui gets LANGFUSE_CONSOLE_URL=${JSON.stringify(url)} — it must be an explicit empty string, or every trace link in the OS points at a host that no longer answers`);
  }
  expectFail(`STACKIT profile + ${key} exposed with NO protection annotation`, ['-f', STACKIT, ...HOST, ...EXPOSE]);
  expectFail(`STACKIT profile + ${key} exposed with an allowlist of 0.0.0.0/0`, ['-f', STACKIT, ...HOST, ...EXPOSE, ...annotation('0.0.0.0/0')]);

  // The control: a protected opt-in renders exactly one route, carrying the protection.
  const label = `STACKIT profile + ${key} exposed behind an IP allowlist (control)`;
  try {
    const got = ingressesTo(render(['-f', STACKIT, ...HOST, ...EXPOSE, ...annotation('203.0.113.7/32')]), CONSOLES[key]);
    if (got.length !== 1) problems.push(`${label}: expected exactly 1 Ingress, found ${got.length} — the detector no longer sees the route, so the other cases prove nothing`);
    else if (!got[0].includes(ALLOWLIST) || !got[0].includes('203.0.113.7/32')) problems.push(`${label}: the Ingress does not carry the ${ALLOWLIST} annotation`);
  } catch (e) {
    problems.push(`${label}: helm template failed — ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}
finish(null);
