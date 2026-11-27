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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

// ITS OWN ACCOUNT (PR #334 review B1, 2026-11-24). Admin credentials kept off the worker's ENV are
// worthless if its ServiceAccount can simply READ them as Secrets. The worker runs as `os-ui-worker`;
// in its own namespace it may be bound only to its own Role and the read-only backup-status Role, and
// none of them may grant Secrets — its only Secret rights are in the dedicated conn-secrets namespace.
function workerRbac(rendered, label) {
  const worker = deployments(rendered).get('os-ui-worker');
  const problemsBefore = problems.length;
  if (worker && !/serviceAccountName: os-ui-worker\n/.test(worker)) problems.push('os-ui-worker must run as its own ServiceAccount `os-ui-worker` — sharing `os-ui` hands the agent-run pod every os-ui grant');
  const all = rendered.split(/^---$/m);
  const nsOf = (d) => d.match(/^\s{2}namespace: "?([^"\n]+)"?$/m)?.[1];
  const nameOf = (d) => d.match(/^metadata:\n(?:.*\n)*?\s{2}name: "?([^"\n]+)"?$/m)?.[1];
  const workerNs = worker ? nsOf(worker) : undefined;
  const roles = new Map(all.filter((d) => /^kind: Role$/m.test(d) && nsOf(d) === workerNs).map((d) => [nameOf(d), d]));
  const bindings = all.filter((d) => /^kind: (Cluster)?RoleBinding$/m.test(d) && /name: "?os-ui-worker"?/.test(d.split('subjects:')[1] ?? ''));
  // In its own namespace: its Role and the read-only backup-status Role. NOT the scanner Role there — it
  // creates Jobs, and a Job may run as any ServiceAccount beside the platform (check-dagster-pod-admission).
  const OWN_NS_OK = ['os-ui-worker', 'os-ui-backup-status'];
  for (const b of bindings) {
    const ref = b.match(/roleRef:[\s\S]*?name: "?([a-z0-9-]+)"?/)?.[1];
    if (nsOf(b) === workerNs || /^kind: ClusterRoleBinding$/m.test(b)) {
      if (!OWN_NS_OK.includes(ref)) problems.push(`os-ui-worker is bound to ${ref} by ${nameOf(b)} in its own namespace — allowed there: ${OWN_NS_OK.join(', ')}`);
      const role = roles.get(ref);
      const readsSecrets = role && role.split(/\n\s+- apiGroups:/).slice(1).some((r) => /resources: \[[^\]]*"secrets"/.test(r) && /verbs: \[[^\]]*"(get|list|watch|update|patch|\*)"/.test(r));
      if (readsSecrets) problems.push(`os-ui-worker's Role ${ref} lets it READ Secrets in the release namespace — the worker must not be able to read litellm-credentials / os-ui-session`);
    }
  }

  // EVERY KUBERNETES CALL THE WORKER CAN MAKE IS COVERED (PR #334 re-verify). The worker loads every MCP
  // tool, so a module that calls `@core/infra/k8s` and is reachable from worker/agent-runs.ts is a call
  // the worker WILL make. Trace the import graph from the entrypoint; each k8s-using module must be
  // classified below — covered by a named Role the worker is bound to (when the feature renders), or
  // deliberately denied with the reason. A NEW reachable k8s module fails this check until classified.
  // A Role counts only where it renders in this profile (softwareRunner, the scanner, Tekton checks,
  // backup alerts and the Velero watch are each optional).
  const COVERAGE = {
    'core/infra/secrets.ts': { roles: ['os-ui-connection-secrets'] },
    'core/adapters/tekton/client.ts': { roles: ['os-ui-software-checks'] },
    // App Builder (D): an app's database/env objects in apps-dev/apps-prod (only with the switch on and mode cnpg).
    'core/adapters/cnpg/client.ts': { roles: ['os-ui-app-databases'] },
    'core/infra/backup-sources.ts': { roles: ['os-ui-backup-status', 'os-ui-velero-backups'] },
    'tabs/monitoring/lib/adapters/backup-health.ts': { roles: ['os-ui-worker'] }, // restore-drill ConfigMap by name
    'core/infra/trino-rules-server.ts': { roles: ['os-ui-worker'] }, // trino-access-rules by name
    'tabs/data/lib/sync-cron-removal.ts': { roles: ['os-ui-worker'] }, // CronJob delete only
    'tabs/monitoring/lib/panels/software-panel.ts': { roles: ['os-ui-apps-runner'] },
    'tabs/software/lib/runner.ts': { roles: ['os-ui-apps-runner'] },
    // Only where the scan has its OWN namespace; beside os-ui a run's scan request answers 403 (see above).
    'tabs/software/lib/scan-trivy.ts': { roles: ['os-ui-software-scanner'], dedicatedOnly: true },
    'tabs/connections/lib/warehouse/k8s-registration.ts': { denied: 'writes ConfigMaps + Secrets in the release namespace — os-ui only; a run answers 403' },
  };

  const ui = join(repo, 'os-ui');
  const exts = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];
  const resolveSpec = (from, spec) => {
    let base;
    if (spec.startsWith('@core/')) base = join(ui, 'core', spec.slice(6));
    else if (spec.startsWith('@tabs/')) base = join(ui, 'tabs', spec.slice(6));
    else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
    else return null;
    for (const e of exts) if (existsSync(base + e) && statSync(base + e).isFile()) return base + e;
    return null;
  };
  const entry = join(ui, 'worker', 'agent-runs.ts');
  const seen = new Set([entry]);
  const queue = [entry];
  const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  while (queue.length) {
    const f = queue.shift();
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      const r = resolveSpec(f, m[1] || m[2] || m[3]);
      if (r && !seen.has(r) && !r.endsWith('.test.ts')) { seen.add(r); queue.push(r); }
    }
  }
  const k8sFile = join(ui, 'core', 'infra', 'k8s.ts');
  const reached = [...seen].filter((f) => f !== k8sFile && /infra\/k8s'/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ui.length + 1)).sort();
  if (!seen.has(k8sFile)) problems.push('the import trace from worker/agent-runs.ts no longer reaches core/infra/k8s.ts — the trace is broken, so coverage proves nothing');
  const boundRoles = new Set(bindings.map((b) => b.match(/roleRef:[\s\S]*?name: "?([a-z0-9-]+)"?/)?.[1]));
  for (const f of reached) {
    const c = COVERAGE[f];
    if (!c) { problems.push(`${f} calls Kubernetes and is reachable from the worker, but scripts/check-worker-env.mjs does not say which Role covers it — classify it (grant through a scoped Role, or deny with a reason)`); continue; }
    if (c.denied) continue;
    for (const r of c.roles) {
      const role = all.find((d) => /^kind: Role$/m.test(d) && nameOf(d) === r);
      if (!role) continue; // the feature's Role is not rendered in this profile
      if (c.dedicatedOnly && nsOf(role) === workerNs) continue; // deliberately not granted beside os-ui
      if (!boundRoles.has(r)) problems.push(`${f} is reachable from the worker but os-ui-worker is not bound to ${r}`);
    }
  }
  for (const f of Object.keys(COVERAGE)) if (!reached.includes(f)) problems.push(`COVERAGE lists ${f}, which the worker no longer reaches (or no longer calls k8s) — remove it so the map stays true`);
  for (let i = problemsBefore; i < problems.length; i++) problems[i] = `[${label}] ${problems[i]}`;
}
workerRbac(rendered, 'values.local');
// Every optional Role the worker's tools use, rendered at once — so coverage is checked where it exists.
workerRbac(
  execFileSync('helm', ['template', 'soa', CHART, '-n', 'agentic-os', '-f', VALUES, '--set', 'osUI.worker.enabled=true', '--set', 'softwareRunner.enabled=true', '--set', 'osUI.software.scanner.enabled=true', '--set', 'osUI.software.tekton.enabled=true', '--set', 'observability.backupAlerts.velero.namespace=velero', '--set', 'observability.backupAlerts.velero.scheduleName=daily-agentic-os'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
  'all worker-tool features on',
);
// The scanner in its OWN namespace: there the worker IS bound to its Role.
workerRbac(
  execFileSync('helm', ['template', 'soa', CHART, '-n', 'agentic-os', '-f', VALUES, '--set', 'osUI.worker.enabled=true', '--set', 'osUI.software.scanner.enabled=true', '--set', 'osUI.software.scanner.namespace=agentic-scan'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
  'dedicated scan namespace',
);

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
