#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — the model gateway (LiteLLM) has no public route
 * USER STORY: As a security reviewer I want CI to fail the moment a values or template change
 *             publishes the gateway again, because it holds the provider credentials and an admin
 *             API, and for 143 days production answered the internet on its own hostname with
 *             nothing in front of it but LiteLLM's own login.
 * ARCHITECTURE:
 *   - Renders the chart and inspects every RENDERED `Ingress`: one whose backend Service is the
 *     gateway (`<release>-litellm`) is a public route, whichever template or subchart made it.
 *     So this also catches the `litellm-helm` subchart's own `litellm.ingress.enabled`.
 *   - Asserts, in order:
 *       1. default values                                  → no gateway Ingress;
 *       2. `values.stackit-managed.yaml` over the default  → no gateway Ingress;
 *       3. STACKIT + `ingress.hosts.litellm` set (the old production state, and what a stale
 *          private overlay still carries)                  → STILL no gateway Ingress;
 *       4. STACKIT + host + `ingress.exposeGateway=true`   → exactly one. This is the control: it
 *          proves the detector can see a gateway Ingress, so 1-3 are not passing vacuously.
 *   - And statically (no helm needed): neither committed profile sets `ingress.exposeGateway`,
 *     `ingress.hosts.litellm` or `litellm.ingress.enabled`. The opt-in is for a private overlay
 *     whose owner has put authentication in front of the route — never for a committed profile.
 *   - SKIPS the rendered half (exit 0, loudly) when `helm` is not on PATH or the subchart `.tgz`
 *     files have not been fetched; **in CI (`process.env.CI`) a skip is a hard FAILURE**, exactly
 *     as in `check-worker-env.mjs`. The static half always runs.
 *   - Wired into `os-ui/scripts/gate.sh`. docs/components/litellm.md ("Not reachable from the
 *     internet") is the documentation of the opt-in.
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
const GATEWAY_SERVICE = `${RELEASE}-litellm`;

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
    if (v.ingress?.exposeGateway !== undefined && v.ingress.exposeGateway !== false) {
      problems.push(`${name}: ingress.exposeGateway is ${JSON.stringify(v.ingress.exposeGateway)} — a committed profile must not publish the gateway (use a private overlay, with your own auth in front)`);
    }
    if (v.ingress?.hosts?.litellm) {
      problems.push(`${name}: ingress.hosts.litellm is set (${JSON.stringify(v.ingress.hosts.litellm)}) — the gateway has no public hostname; remove it`);
    }
    if (v.litellm?.ingress?.enabled) {
      problems.push(`${name}: litellm.ingress.enabled is true — the subchart's own Ingress would publish the gateway`);
    }
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
    console.error('check-gateway-not-public FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (skipped) {
    if (process.env.CI) {
      console.error(`check-gateway-not-public: ${skipped} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
      process.exit(1);
    }
    console.log(`check-gateway-not-public: ${skipped} — rendered checks SKIPPED (static checks passed; see docs/components/litellm.md)`);
    process.exit(0);
  }
  console.log('check-gateway-not-public: ok — no Ingress reaches the gateway on the default or the STACKIT profile, a bare ingress.hosts.litellm renders nothing, and the explicit opt-in is the only way to render one');
  process.exit(0);
}

/** Names of the rendered Ingress objects whose backend is the gateway Service. */
function gatewayIngresses(args) {
  const text = execFileSync('helm', ['template', RELEASE, CHART, '-n', 'agentic-os', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const out = [];
  for (const doc of text.split(/^---\s*$/m)) {
    if (!/^kind: Ingress\s*$/m.test(doc)) continue;
    // Strip comments so a commented-out backend cannot count either way.
    const body = doc.replace(/^\s*#.*$/gm, '');
    const backends = [...body.matchAll(/^\s+(?:name|serviceName): "?([A-Za-z0-9.-]+)"?\s*$/gm)].map((m) => m[1]);
    if (backends.includes(GATEWAY_SERVICE)) {
      out.push(body.match(/^metadata:\n(?:.*\n)*?\s{2}name: "?([^\s"]+)"?\s*$/m)?.[1] ?? '(unnamed)');
    }
  }
  return out;
}

if (!helmAvailable()) finish('helm not on PATH');
if (!subchartsPresent()) finish('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

const HOST = ['--set', 'ingress.hosts.litellm=litellm.example.test'];
const cases = [
  { name: 'default values', args: [], want: 0 },
  { name: 'STACKIT profile', args: ['-f', STACKIT], want: 0 },
  { name: 'default + ingress.enabled + ingress.hosts.litellm, no opt-in', args: ['--set', 'ingress.enabled=true', ...HOST], want: 0 },
  { name: 'STACKIT profile + ingress.hosts.litellm, no opt-in', args: ['-f', STACKIT, ...HOST], want: 0 },
  { name: 'STACKIT profile + ingress.hosts.litellm + ingress.exposeGateway=true (control)', args: ['-f', STACKIT, ...HOST, '--set', 'ingress.exposeGateway=true'], want: 1 },
];
for (const c of cases) {
  let got;
  try {
    got = gatewayIngresses(c.args);
  } catch (e) {
    problems.push(`${c.name}: helm template failed — ${String(e.message).split('\n')[0]}`);
    continue;
  }
  if (got.length !== c.want) {
    problems.push(
      c.want === 0
        ? `${c.name}: renders a PUBLIC route to the gateway (${got.join(', ')}) — the gateway must not be reachable from outside the cluster`
        : `${c.name}: expected exactly ${c.want} gateway Ingress, found ${got.length} — the detector no longer sees the route, so the other cases prove nothing`,
    );
  }
}
finish(null);
