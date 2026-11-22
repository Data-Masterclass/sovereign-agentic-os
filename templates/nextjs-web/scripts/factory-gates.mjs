/**
 * FEATURE:    The quality gates of the Software Factory, runnable anywhere (laptop, CI, OS sandbox).
 * USER STORY: As the author of this app I want to run the exact checks the platform runs before a
 *             deploy, and see which one blocks me and why.
 * ARCHITECTURE: Runs `typecheck`, `lint`, `test` as child processes and the `policy` gate through
 *               OPA (a running server at OPA_URL, else the `opa` binary). If OPA is not available the
 *               policy gate is `unavailable`, which is NOT a pass. Prints one framed JSON report.
 *               Vulnerability scanning (Trivy) is run by the platform, not here.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

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

function npmGate(id, script, root) {
  const r = spawnSync('npm', ['run', '--silent', script], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
  return { id, status: r.status === 0 ? 'pass' : 'fail', detail: r.status === 0 ? `npm run ${script} passed` : tail };
}

export async function runGates(root = process.cwd(), env = process.env) {
  const gates = [npmGate('typecheck', 'typecheck', root), npmGate('lint', 'lint', root), npmGate('tests', 'test', root), await policyGate(root, env)];
  return { schema: 'os-gates/v1', template: 'nextjs-web', ok: gates.every((g) => g.status === 'pass'), gates };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runGates();
  process.stdout.write(`${REPORT_DELIM}\n${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}
