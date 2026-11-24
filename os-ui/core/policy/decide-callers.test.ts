/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WHO MAY CALL `decide()` — a source-level ratchet.
 *
 * `decide()` (`core/policy/approvals.ts`) transitions an approval and, for a parked agent run,
 * resumes it. It checks nothing about WHO is deciding: that is each caller's job. One caller —
 * the legacy `/api/agent/approvals` route — had only a role floor, so any Builder could approve
 * their own run's held call. This test makes the set of callers explicit:
 *
 *   - every non-test file that imports `decide` from the approvals module must be listed below,
 *     with the guard a reviewer found in it;
 *   - a file that decides an id the CALLER SUPPLIES must call `canApprove(`;
 *   - a file listed as "imports it, never calls it" must really not call it.
 *
 * A new caller fails here until someone reads it and adds it — with its guard — to the list.
 */

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Decides an approval id the caller supplies → the per-item `canApprove` gate is mandatory. */
const DECIDES_A_SUPPLIED_ID: Record<string, string> = {
  'app/api/governance/approvals/route.ts': 'canSee + canApprove, then the effect, then decide',
  'app/api/agent/approvals/route.ts': 'the same canSee + canApprove as the Governance route (legacy door)',
  'core/mcp/governance-tools.ts': 'decide_approval: canSee + canApprove per item',
  'core/mcp/experimental/promotion-write-tools.ts': 'approve_promotion: canApprove, and refuses any item carrying a runId',
  'tabs/connections/lib/store.ts': 'approveOnce / approveAndRemember (inline Mode A): claimHeldWrite — a connection_write of THIS connection + tool with the exact args hash, canApprove (four eyes: never the requester), still pending, beginApply claim; then decide',
};

/** Decides a record its own flow owns — reviewed, with the guard that flow applies instead. */
const DECIDES_ITS_OWN_RECORD: Record<string, string> = {
  'core/policy/ladder.ts': 'promoteThroughSeam: closes the request its own effect just satisfied, or one it minted; owner / filed-request separation of duties above the call',
  'tabs/software/lib/review.ts': 'decideDeploy: mirrors a deploy-card decision into its app_deploy record(s); gate = Builder+ in the card\'s domain',
  'app/api/files/[id]/promote/route.ts': 'the owner-approver one-shot on the request this same call just filed, after canPromote',
  'app/api/data/datasets/[id]/promote/route.ts': 'the owner-approver one-shot on the request this same call just filed, after canPromote',
};

/** Import `decide` and never call it (a shared import line). Must stay call-free. */
const IMPORTS_BUT_NEVER_CALLS = [
  'core/mcp/agent-write-tools.ts',
  'core/mcp/experimental/data-write-tools.ts',
  'tabs/dashboards/mcp/dashboard-write-tools.ts',
  'tabs/files/mcp/file-write-tools.ts',
  'tabs/knowledge/mcp/knowledge-write-tools.ts',
  'tabs/metrics/mcp/metric-write-tools.ts',
  'tabs/software/mcp/software-write-tools.ts',
];

/**
 * `withdraw()` is the queue's other transition (pending → withdrawn; it resumes the run without
 * executing the call). Same contract: it checks nothing about WHO, so its callers are listed too.
 */
const WITHDRAW_CALLERS: Record<string, string> = {
  'core/policy/withdraw.ts': 'withdrawHeldCall: canSee, still pending, a parked run\'s call, then canWithdraw (the requester only)',
};

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) sourceFiles(join(dir, e.name), out);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** A module specifier that is the approvals queue: the alias, or a relative path to it. */
const APPROVALS_SPEC = String.raw`['"](?:@core/policy/approvals|(?:\.{1,2}/)+(?:[\w.-]+/)*approvals)(?:\.ts)?['"]`;
const NAMED_IMPORT = new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${APPROVALS_SPEC}`, 'g');
const WHOLE_MODULE = new RegExp(String.raw`import\s*\*\s*as\s+\w+\s+from\s*${APPROVALS_SPEC}|import\(\s*${APPROVALS_SPEC}\s*\)|require\(\s*${APPROVALS_SPEC}\s*\)`, 'g');

/** How this file can reach `decide`: the local names it is bound to, and whole-module imports. */
function decideBindings(src: string, file: string, fn = 'decide'): { names: string[]; wholeModule: string[] } {
  const names: string[] = [];
  for (const m of src.matchAll(NAMED_IMPORT)) {
    // A relative `./approvals` only counts inside core/policy (other folders have their own).
    if (!m[0].includes('@core/policy/approvals') && !file.startsWith('core/policy/')) continue;
    for (const part of m[1].split(',')) {
      const mm = part.trim().match(new RegExp(String.raw`^${fn}(?:\s+as\s+(\w+))?$`));
      if (mm) names.push(mm[1] ?? fn);
    }
  }
  const wholeModule = [...src.matchAll(WHOLE_MODULE)]
    .map((m) => m[0])
    .filter((text) => text.includes('@core/policy/approvals') || file.startsWith('core/policy/'));
  return { names, wholeModule };
}

function callCount(src: string, name: string): number {
  return [...src.matchAll(new RegExp(String.raw`(?<![.\w$])${name}\s*\(`, 'g'))].length;
}

const SCAN = sourceFiles(ROOT)
  .map((abs) => ({ file: relative(ROOT, abs).split(sep).join('/'), src: readFileSync(abs, 'utf8') }))
  .filter(({ file }) => file !== 'core/policy/approvals.ts');

test('every non-test file that imports decide() from the approvals queue is on the reviewed list', () => {
  const reviewed = new Set([...Object.keys(DECIDES_A_SUPPLIED_ID), ...Object.keys(DECIDES_ITS_OWN_RECORD), ...IMPORTS_BUT_NEVER_CALLS]);
  const found = SCAN.filter(({ file, src }) => decideBindings(src, file).names.length > 0).map(({ file }) => file).sort();
  assert.deepEqual(
    found.filter((f) => !reviewed.has(f)),
    [],
    'a new importer of decide(): read it, make sure it gates WHO decides (canApprove for a caller-supplied id), then list it in decide-callers.test.ts',
  );
  assert.deepEqual([...reviewed].filter((f) => !found.includes(f)).sort(), [], 'a listed file no longer imports decide() — remove it from the list');
});

test('a file that decides a caller-supplied approval id applies the per-item canApprove gate', () => {
  for (const file of Object.keys(DECIDES_A_SUPPLIED_ID)) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const { names } = decideBindings(src, file);
    assert.ok(names.some((n) => callCount(src, n) > 0), `${file} is listed as a caller and must call decide()`);
    assert.ok(/(?<![.\w$])canApprove\s*\(/.test(src), `${file} decides a supplied id and must call canApprove()`);
    assert.ok(/from\s*['"]@core\/policy\/roles['"]/.test(src), `${file} must take canApprove from core/policy/roles`);
  }
});

test('the files that only import decide() really never call it', () => {
  for (const file of IMPORTS_BUT_NEVER_CALLS) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const name of decideBindings(src, file).names) {
      assert.equal(callCount(src, name), 0, `${file} now CALLS ${name}() — review its guard and move it to a caller list`);
    }
  }
});

test('nothing outside tests reaches decide() through a whole-module import of the approvals queue', () => {
  // A namespace or dynamic import would let a file call `x.decide(` unseen by the checks above.
  const offenders = SCAN.flatMap(({ file, src }) => {
    const { wholeModule } = decideBindings(src, file);
    if (wholeModule.length === 0) return [];
    // Allowed only when the file provably does not touch `decide` at all.
    return /\b(decide|withdraw)\b/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')) ? [file] : [];
  });
  assert.deepEqual(offenders, [], 'import decide by name from @core/policy/approvals so this ratchet can see the caller');
});

test('every non-test file that imports withdraw() from the approvals queue is listed, and gates it with canWithdraw', () => {
  const found = SCAN.filter(({ file, src }) => decideBindings(src, file, 'withdraw').names.length > 0).map(({ file }) => file).sort();
  assert.deepEqual(found, Object.keys(WITHDRAW_CALLERS).sort(), 'a new (or removed) importer of withdraw(): review who it lets withdraw, then update decide-callers.test.ts');
  for (const file of found) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(/(?<![.\w$])canWithdraw\s*\(/.test(src), `${file} must call canWithdraw()`);
  }
});
