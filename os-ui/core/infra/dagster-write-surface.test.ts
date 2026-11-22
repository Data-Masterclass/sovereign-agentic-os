/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS writes to Dagster in exactly four ways (ownership rule: Dagster owns run and
 *             pause state)
 * USER STORY: As a platform engineer I pause a schedule in the Dagster UI and expect it to stay
 *             paused: the OS must never start, resume, terminate or delete anything there.
 * ARCHITECTURE: scans every non-test source for GraphQL `mutation` documents and pins the set.
 *   Adding a write needs a deliberate edit of this list in the same PR. The one stop path (domain
 *   delete) is pinned to its single caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', new URL('..', import.meta.url)).pathname.replace(/\/$/, '');
const SKIP = new Set(['node_modules', '.next', 'vendor']);
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.|\.int\.|\.it\./.test(n)) out.push(p);
  }
  return out;
}

/** Remove comments, so a doc comment that names a mutation is not a mutation. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every GraphQL mutation document in a source, named or anonymous, in a template or a quoted string
 * (single, double, or concatenated): the root field it calls.
 */
export function mutationRoots(src: string): string[] {
  const joined = code(src).replace(/(['"`])\s*\+\s*(['"`])/g, '');
  return [...joined.matchAll(/(?<![\w.])mutation\b\s*(?:\w+\s*)?(?:\([^)]*\)\s*)?\{\s*(\w+)/g)].map((m) => m[1]);
}

test('the only Dagster GraphQL mutations in os-ui are launch, reload, stopRunningSchedule and stopSensor', () => {
  const found = new Set<string>();
  for (const f of walk(ROOT)) {
    for (const root of mutationRoots(readFileSync(f, 'utf8'))) found.add(`${root}@${relative(ROOT, f)}`);
  }
  assert.deepEqual([...found].sort(), [
    'launchRun@core/infra/dagster.ts',
    'reloadRepositoryLocation@core/infra/dagster.ts',
    'stopRunningSchedule@core/infra/dagster.ts',
    'stopSensor@core/infra/dagster.ts',
  ]);
});

test('twin: anonymous, quoted, double-quoted, concatenated and variable-less mutations are all seen', () => {
  assert.deepEqual(mutationRoots('const a = `mutation { startSensor(id: "x") { __typename } }`;'), ['startSensor']);
  assert.deepEqual(mutationRoots("const a = 'mutation { resumeSchedule { __typename } }';"), ['resumeSchedule']);
  assert.deepEqual(mutationRoots('const a = "mutation Go($i: String) { terminateRun(runId: $i) { __typename } }";'), ['terminateRun']);
  assert.deepEqual(mutationRoots("const a = 'mutation ' + '{ deleteRun(runId: 1) { __typename } }';"), ['deleteRun']);
  assert.deepEqual(mutationRoots('const a = `mutation Stop($id: String, $sel: String) {\n  stopSensor(id: $id) { __typename } }`;'), ['stopSensor']);
});

test('twin: prose, comments and unrelated words are not mutations', () => {
  assert.deepEqual(mutationRoots('// mutation { startSensor } is forbidden\nconst a = "no mutation here";'), []);
  assert.deepEqual(mutationRoots('/* mutation Foo { bar } */ const b = 1; const c = state.mutation;'), []);
});

test('twin: no start, resume, terminate or delete mutation exists anywhere', () => {
  for (const f of walk(ROOT)) {
    const src = readFileSync(f, 'utf8');
    if (!/dagster/i.test(src)) continue; // agents' own run store has a deleteRun of its own
    assert.ok(!/startSensor|startRunningSchedule|resumeSchedule|terminateRun|launchPipelineReexecution|launchRunReexecution|resetSensor|deleteRun\b/.test(src), relative(ROOT, f));
  }
});

test('stopInstigator has one caller: the domain-delete cleanup', () => {
  const callers = walk(ROOT).filter((f) => !f.endsWith('core/infra/dagster.ts') && /\bstopInstigator\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(callers, ['core/kernel/domain-delete-components.ts']);
});
