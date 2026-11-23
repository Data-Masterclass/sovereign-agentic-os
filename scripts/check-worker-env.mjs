#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    The os-ui-worker pod holds no admin credentials
 * USER STORY: As a security reviewer I want CI to fail the moment somebody points the worker
 *             Deployment at the full `soa.osUI.env` again, because that puts the LiteLLM MASTER
 *             key, the session-signing secret and the mail secret on the agent-run path — a pod
 *             that serves no HTTP and executes model-driven tool calls.
 * ARCHITECTURE:
 *   - Renders the chart with the worker enabled and asserts, on the RENDERED Deployments:
 *     (1) no admin credential name appears in `os-ui-worker`; (2) the run path's own credentials
 *     (the scoped agent key, the run store, Langfuse) DO; (3) `os-ui` still carries every admin
 *     name, so the split did not simply drop them.
 *   - SKIPS (exit 0, loudly) when `helm` is not on PATH, when `values.local.yaml` is absent, or
 *     when the chart's subchart `.tgz` files have not been fetched (`helm dependency build`) —
 *     the unit gate must run on a laptop with no Kubernetes tooling. `docs/components/os-ui.md`
 *     carries the same check by hand.
 *   - **In CI (`process.env.CI`) a skip is a hard FAILURE.** A check that silently skips on the
 *     one machine that is supposed to enforce it is not a check: this script rendered nothing in
 *     CI for as long as the subcharts were missing, because `helm template` then exits 1 with
 *     "found in Chart.yaml, but missing in charts/ directory" and the gate died on the raw error
 *     rather than on anything this file asserts (deviation F-7).
 *   - No dependencies, no YAML parser: it splits the manifest stream and matches `- name: X`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');

/** Never on the run path: full gateway admin, session forging, outbound mail. */
const ADMIN_ONLY = ['LITELLM_MASTER_KEY', 'LITELLM_UI_USERNAME', 'LITELLM_UI_PASSWORD', 'GRAPH_CLIENT_SECRET', 'OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET', 'LANGFUSE_SSO_PASSWORD'];
/** The run path cannot work without these, so their absence is a broken split, not a safe one. */
const RUN_PATH = ['LITELLM_AGENT_KEY', 'AGENT_RUNS_DATABASE_URL', 'LANGFUSE_SECRET_KEY', 'OPA_URL', 'AGENT_KEY_ENCRYPTION_KEY', 'OS_SECRETS_BACKEND', 'OS_SECRETS_ENCRYPTION_KEY'];
/**
 * BUILD-only configuration (2026-11-19): what os-ui's Build needs to mint and reconcile a system's
 * model key. The worker never mints or updates a key — it only decrypts the stored one — so these
 * must be on os-ui and must NOT be on the worker.
 */
const BUILD_ONLY = ['AGENT_SYSTEM_KEY_FALLBACKS_JSON'];
/** The Secret the per-system keys are encrypted under, and the template that generates it. */
const KEK_ENV = 'AGENT_KEY_ENCRYPTION_KEY';
const KEK_SECRET = 'os-ui-agent-key-encryption';
const KEK_TEMPLATE = join(CHART, 'templates', 'base', 'os-ui', 'os-ui-agent-key-encryption.yaml');
/**
 * Must be on BOTH pods, EXPLICITLY (2026-11-18). `OS_OFFLINE_MOCK` decides whether this
 * deployment may answer with fabricated data; the os-ui-worker EXECUTES agent runs, so a worker
 * that disagreed with the UI would have agents fabricating while the UI refused. The predecessor
 * gate keyed on `OS_PROFILE`, which no chart ever set — hence "explicitly": it is asserted
 * PRESENT here, not merely assumed to have a sensible default in code.
 */
const BOTH_PODS = ['OS_OFFLINE_MOCK'];

function helmAvailable() {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Have the subcharts been fetched? `helm template` cannot render the chart without them. */
function subchartsPresent() {
  const dir = join(CHART, 'charts');
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.tgz'));
}

/**
 * A reason this check cannot run. On a laptop that is a loud skip; in CI it is a failure, because
 * CI is where the check has to bite. The fix in CI is always the same: run
 * `helm dependency build charts/sovereign-agentic-os` before the gate.
 */
function skip(why) {
  if (process.env.CI) {
    console.error(`check-worker-env: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`check-worker-env: ${why} — SKIPPED (see docs/components/os-ui.md for the manual check)`);
  process.exit(0);
}

function deployments(text) {
  const out = new Map();
  for (const doc of text.split(/^---$/m)) {
    if (!/^kind: Deployment$/m.test(doc)) continue;
    const name = doc.match(/^metadata:\n(?:.*\n)*?\s{2}name: (\S+)$/m)?.[1] ?? doc.match(/^\s{2}name: (\S+)$/m)?.[1];
    if (name) out.set(name, doc);
  }
  return out;
}

const names = (doc) => new Set([...doc.matchAll(/^\s+- name: ([A-Z0-9_]+)$/gm)].map((m) => m[1]));

if (!helmAvailable()) skip('helm not on PATH');
if (!existsSync(VALUES)) skip(`${VALUES} missing`);
if (!subchartsPresent()) skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

const rendered = execFileSync('helm', ['template', CHART, '-f', VALUES, '--set', 'osUI.worker.enabled=true', '--set', 'osUI.graph.enabled=true'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const found = deployments(rendered);
const worker = found.get('os-ui-worker');
const osui = found.get('os-ui');
const problems = [];
if (!worker) problems.push('os-ui-worker Deployment not rendered with osUI.worker.enabled=true');
if (!osui) problems.push('os-ui Deployment not rendered');

if (worker) {
  const have = names(worker);
  for (const n of ADMIN_ONLY) if (have.has(n)) problems.push(`os-ui-worker carries the ADMIN-ONLY env ${n} — include soa.osUI.runEnv, not soa.osUI.env`);
  for (const n of RUN_PATH) if (!have.has(n)) problems.push(`os-ui-worker is MISSING the run-path env ${n} — the split dropped something a run needs`);
  for (const n of BOTH_PODS) if (!have.has(n)) problems.push(`os-ui-worker is MISSING ${n} — the honesty switch must be set explicitly on the run path too`);
  for (const n of BUILD_ONLY) if (have.has(n)) problems.push(`os-ui-worker carries the BUILD-only env ${n} — the worker never mints or updates a key`);
}
if (osui) {
  const have = names(osui);
  for (const n of ADMIN_ONLY) if (!have.has(n)) problems.push(`os-ui is MISSING ${n} — soa.osUI.env must still include soa.osUI.adminEnv`);
  for (const n of BOTH_PODS) if (!have.has(n)) problems.push(`os-ui is MISSING ${n} — the honesty switch must be set explicitly`);
  for (const n of BUILD_ONLY) if (!have.has(n)) problems.push(`os-ui is MISSING ${n} — Build could not put the gateway's fallback models on a system's key`);
  if (!have.has(KEK_ENV)) problems.push(`os-ui is MISSING ${KEK_ENV} — Build could not store a system's key`);
}

// THE KEY-ENCRYPTION SECRET (2026-11-19). Per-system model keys are stored encrypted under it; if
// it changed on a `helm upgrade`, every stored key would become unreadable and every system would
// need a Rebuild. A renderer cannot observe an upgrade (`lookup` is empty under `helm template`),
// so this asserts the four things it CAN see:
//   1. both pods read it from its OWN Secret — never from the Secret holding the LiteLLM master key;
//   2. the template keeps the value: it reads the live Secret back with `lookup` and carries
//      `helm.sh/resource-policy: keep`;
//   3. an explicit value renders unchanged, twice in a row (no hidden randomness in that path);
//   4. `existingSecret` is honoured: no Secret is rendered and both pods reference the named one.
{
  /** The Secret name the pod reads `KEK_ENV` from. */
  const kekSource = (doc) => doc.match(new RegExp(`- name: ${KEK_ENV}\\n\\s+valueFrom:\\n\\s+secretKeyRef:\\n\\s+name: "?([^"\\n]+)"?`))?.[1];
  const masterSource = osui?.match(/- name: LITELLM_MASTER_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: "?([^"\n]+)"?/)?.[1];
  for (const [pod, doc] of [['os-ui', osui], ['os-ui-worker', worker]]) {
    if (!doc) continue;
    const src = kekSource(doc);
    if (src !== KEK_SECRET) problems.push(`${pod}: ${KEK_ENV} is read from "${src ?? '(nothing)'}" — it must come from the dedicated Secret ${KEK_SECRET}`);
    if (src && src === masterSource) problems.push(`${pod}: ${KEK_ENV} comes from the Secret that holds the LiteLLM master key — the encryption secret must be independent of it`);
  }

  const tpl = existsSync(KEK_TEMPLATE) ? readFileSync(KEK_TEMPLATE, 'utf8') : '';
  if (!tpl) problems.push(`${KEK_TEMPLATE} is missing — nothing generates the key-encryption secret`);
  else {
    if (!/lookup "v1" "Secret" \.Release\.Namespace \$name/.test(tpl)) problems.push('the key-encryption Secret template no longer reads the live Secret back (`lookup`) — a `helm upgrade` would generate a NEW value and make every stored key unreadable');
    if (!/"helm\.sh\/resource-policy": keep/.test(tpl)) problems.push('the key-encryption Secret template lost `helm.sh/resource-policy: keep`');
  }

  const FIXED = 'check-only-not-a-real-secret-0123456789abcdef';
  const secretDoc = (text) => text.split(/^---$/m).find((d) => /^kind: Secret$/m.test(d) && new RegExp(`^  name: ${KEK_SECRET}$`, 'm').test(d));
  const withValue = () => execFileSync('helm', ['template', CHART, '-f', VALUES, '--set', `osUI.agentKeyEncryption.secret=${FIXED}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const [a, b] = [secretDoc(withValue()), secretDoc(withValue())];
  if (!a || !a.includes(`${KEK_ENV}: "${FIXED}"`) || a !== b) problems.push('an explicit osUI.agentKeyEncryption.secret does not render unchanged on two consecutive renders');
  if (!secretDoc(rendered)) problems.push(`the default render has no ${KEK_SECRET} Secret — a fresh install would start without an encryption secret`);

  const ext = execFileSync('helm', ['template', CHART, '-f', VALUES, '--set', 'osUI.worker.enabled=true', '--set', 'osUI.agentKeyEncryption.existingSecret=operator-managed-kek'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (secretDoc(ext)) problems.push('osUI.agentKeyEncryption.existingSecret is set but the chart still renders its own Secret');
  for (const [pod, doc] of deployments(ext)) {
    if (pod !== 'os-ui' && pod !== 'os-ui-worker') continue;
    if (kekSource(doc) !== 'operator-managed-kek') problems.push(`${pod}: does not read ${KEK_ENV} from osUI.agentKeyEncryption.existingSecret`);
  }
}

// The DEFAULT render (chart values only) must REFUSE. values.local.yaml deliberately sets
// `allow` for the laptop teaching flow, so the default has to be asserted on its own render —
// a default that is only right in the one profile nobody deploys is how OS_PROFILE happened.
{
  const def = execFileSync('helm', ['template', CHART, '--set', 'osUI.worker.enabled=true'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const [pod, doc] of deployments(def)) {
    if (pod !== 'os-ui' && pod !== 'os-ui-worker') continue;
    const value = doc.match(/- name: OS_OFFLINE_MOCK\n\s+value: "([^"]*)"/)?.[1];
    if (value !== 'refuse') {
      problems.push(`${pod}: OS_OFFLINE_MOCK renders as ${value === undefined ? '(absent)' : `"${value}"`} on a DEFAULT install — it must be "refuse"`);
    }
  }
}

if (problems.length) {
  console.error('check-worker-env FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-worker-env: ok — os-ui-worker holds none of ${ADMIN_ONLY.length} admin credentials (the LiteLLM master key among them) and all ${RUN_PATH.length} run-path ones; OS_OFFLINE_MOCK is explicit on both pods and defaults to refuse; the key-encryption secret is dedicated, kept across upgrades and honours an explicit value`);
