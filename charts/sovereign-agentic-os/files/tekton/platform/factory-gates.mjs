/**
 * FEATURE:    The quality gates of the Software Factory, runnable anywhere (laptop, CI, OS sandbox).
 * USER STORY: As the author of this app I want to run the exact checks the platform runs before a
 *             deploy, and see which one blocks me and why.
 * ARCHITECTURE: Runs `typecheck` (tsc), `lint` (eslint), `build` (next build) and the tests (node --test, at least one file) as child
 *               processes with platform-defined commands, and the `policy` gate through OPA (a running
 *               server at OPA_URL, else the `opa` binary). If OPA is not available the policy gate is
 *               `unavailable`, which is NOT a pass. In the OS sandbox this file is the PLATFORM's copy, run
 *               once per gate (`--gate <id>`) and judged by its exit code; the author's copy is never run
 *               there. Without `--gate` it prints one framed JSON report for the laptop.
 *               Vulnerability scanning (Trivy) is run by the platform, not here.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

export const REPORT_DELIM = '<<<OS-GATES-REPORT>>>';
const SKIP = new Set(['node_modules', '.next', '.git', 'vendor']);
const TEXT = /\.(ts|tsx|mjs|js|json|yaml|yml|md|rego|css)$|(^|\/)(Dockerfile|\.gitignore|\.dockerignore|\.npmrc)$|(^|\/)\.env(\..*)?$/;

export function collectFacts(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const path = relative(root, abs).split('\\').join('/');
        if (TEXT.test(path)) files.push({ path, content: readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(root);
  return { files };
}

async function policyGate(root, env) {
  const facts = collectFacts(root);
  if (env.OPA_URL) {
    try {
      // OPA runs as a sidecar that may still be starting: wait for it (bounded) before calling it unavailable.
      const base = env.OPA_URL.replace(/\/$/, '');
      for (let i = 0; i < 30; i++) {
        const up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
        if (up) break;
        await sleep(1000);
      }
      const res = await fetch(`${env.OPA_URL.replace(/\/$/, '')}/v1/data/factory/deny`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: facts }),
      });
      if (!res.ok) return { id: 'policy', status: 'unavailable', detail: `OPA answered HTTP ${res.status}` };
      const { result } = await res.json();
      return verdict(result ?? []);
    } catch (e) {
      return { id: 'policy', status: 'unavailable', detail: `OPA at ${env.OPA_URL} unreachable: ${e.message}` };
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'gates-'));
  const input = join(dir, 'input.json');
  writeFileSync(input, JSON.stringify(facts));
  const r = spawnSync(env.OPA_BIN || 'opa', ['eval', '--format', 'json', '--data', join(root, 'policy'), '--input', input, 'data.factory.deny'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { id: 'policy', status: 'unavailable', detail: `opa could not run (${r.error ? r.error.message : (r.stderr || '').slice(0, 200)}); set OPA_URL or install opa` };
  }
  const value = JSON.parse(r.stdout).result?.[0]?.expressions?.[0]?.value ?? [];
  return verdict(value);
}

function verdict(violations) {
  const list = [...violations].sort();
  return list.length === 0
    ? { id: 'policy', status: 'pass', detail: 'no rule violated' }
    : { id: 'policy', status: 'fail', detail: `${list.length} violation(s)`, violations: list };
}

const TOOL = { typecheck: ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'], lint: ['node_modules/eslint/bin/eslint.js', '.'], build: ['node_modules/next/dist/bin/next', 'build'] };

function toolGate(id, root) {
  const [bin, ...args] = TOOL[id];
  const r = spawnSync(process.execPath, [join(root, bin), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const tail = out.split('\n').slice(-25).join('\n');
  if (r.status === 0) return { id, status: 'pass', detail: `${id} passed` };
  if (r.error) return { id, status: 'unavailable', detail: `${id} could not run: ${r.error.message}` };
  return { id, status: 'fail', detail: tail || `${id} exited ${r.status}` };
}

function testFiles(root) {
  const found = [];
  const walk = (dir) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.test\.(ts|tsx|mjs|js)$/.test(name)) found.push(relative(root, abs));
    }
  };
  walk(join(root, 'tests'));
  return found.sort();
}

function testsGate(root) {
  const files = testFiles(root);
  // A gate that ran no tests is not a pass.
  if (files.length === 0) return { id: 'tests', status: 'fail', detail: 'no test files found under tests/ (a gate that ran nothing is not a pass)' };
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
  if (r.error) return { id: 'tests', status: 'unavailable', detail: `tests could not run: ${r.error.message}` };
  return { id: 'tests', status: r.status === 0 ? 'pass' : 'fail', detail: r.status === 0 ? `${files.length} test file(s) passed` : tail };
}

export const GATE_IDS = ['typecheck', 'lint', 'tests', 'build', 'policy'];

export async function runGate(id, root = process.cwd(), env = process.env) {
  if (id === 'policy') return policyGate(root, env);
  if (id === 'tests') return testsGate(root);
  if (TOOL[id]) return toolGate(id, root);
  return { id, status: 'unavailable', detail: `unknown gate '${id}'` };
}

/** Run every gate, or only `only` (a list of gate ids): the CI pipeline runs one gate per step so each gets its own status and log. */
export async function runGates(root = process.cwd(), env = process.env, only = GATE_IDS) {
  const gates = [];
  for (const id of GATE_IDS) if (only.includes(id)) gates.push(await runGate(id, root, env));
  return { schema: 'os-gates/v1', template: 'nextjs-web', ok: gates.every((g) => g.status === 'pass'), gates };
}

/**
 * Exit codes, the contract the platform sandbox reads (it never reads this output): 0 = the gate passed,
 * 3 = the gate could not run (not a pass), anything else = it failed.
 *   node scripts/factory-gates.mjs                     all gates, framed report, for the author on a laptop
 *   node scripts/factory-gates.mjs --gate <id> [--root <dir>]   one gate: the platform runs it this way
 */
// `import.meta.url` is the REAL path; `argv[1]` is the path as invoked. They differ when this file is reached through a
// symlink (a ConfigMap volume mounts every file as one), and a main guard that compares them raw silently runs nothing and
// exits 0, a gate that passes without running. Compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const root = arg('--root') ?? process.cwd();
  const one = arg('--gate');
  if (one) {
    const g = await runGate(one, root);
    process.stdout.write(`${g.status.toUpperCase()} ${g.id}: ${g.detail}\n${(g.violations ?? []).map((v) => `  - ${v}\n`).join('')}`);
    process.exit(g.status === 'pass' ? 0 : g.status === 'unavailable' ? 3 : 1);
  }
  // `--only typecheck,lint` runs a subset (the .tekton pipeline runs one gate per step); an unknown id is an error, never a silent pass.
  const at = process.argv.indexOf('--only');
  const only = at > 0 ? String(process.argv[at + 1] ?? '').split(',').filter(Boolean) : GATE_IDS;
  const unknown = only.filter((id) => !GATE_IDS.includes(id));
  if (only.length === 0 || unknown.length > 0) {
    process.stderr.write(`unknown gate: ${unknown.join(',') || '(none given)'}; known: ${GATE_IDS.join(', ')}\n`);
    process.exit(2);
  }
  const report = await runGates(root, process.env, only);
  process.stdout.write(`${REPORT_DELIM}\n${JSON.stringify(report)}\n`);
  // One gate (the CI pipeline runs one per step): the same exit codes as `--gate`. Several: 0 only when all passed.
  const [only1] = report.gates.length === 1 ? report.gates : [];
  process.exit(only1 ? (only1.status === 'pass' ? 0 : only1.status === 'unavailable' ? 3 : 1) : report.ok ? 0 : 1);
}
