/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    Guard: no OS source file hard-codes a model name. The OS calls the three role names only.
 * USER STORY: As the owner I do not want a model name hidden in code that a remap in Platform → Models
 *             cannot reach. The catalog (real model names) lives in LiteLLM and is seeded by the chart.
 * ARCHITECTURE:
 *   - Scans the non-test source of os-ui for the old alias names (sovereign-default, -mock, -reasoning,
 *     -reasoning-fast, -premium, -vision, -embed) and real model names (gpt-oss, Qwen3…), outside comments.
 *   - Allowed: the deprecated-alias table (`role-mapping.ts`, it IS the one-release compatibility map)
 *     and the provider wizard's placeholder text. The chart's catalog seed is outside os-ui.
 *   - The scanner has a negative twin: it must flag a planted hard-coded name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', 'tests', '__fixtures__']);
const ALLOWED = new Set(['core/models/role-names.ts', 'tabs/admin/lib/llm-provider-presets.ts']);
const NAME = /\b(sovereign-(default|mock|reasoning-fast|reasoning|premium|vision|embed)\b|gpt-oss|qwen3?[-\s]?vl|qwen3)/i;

/** The code of a file without its comments (a name in a comment is documentation, not a call). */
export function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
export function hardCodedModelNames(src: string): string[] {
  return codeOnly(src).split('\n').filter((l) => NAME.test(l)).map((l) => l.trim().slice(0, 120));
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.(test|e2e\.test|spec)\.(ts|tsx|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test('GUARD: no OS source file hard-codes a model name (the OS calls the three role names)', () => {
  const offenders: string[] = [];
  for (const file of sources(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const hits = hardCodedModelNames(readFileSync(file, 'utf8'));
    if (hits.length) offenders.push(`${rel}: ${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1})` : ''}`);
  }
  assert.deepEqual(offenders, [], `hard-coded model names:\n${offenders.join('\n')}`);
});

test('NEGATIVE TWIN: the scanner flags a planted hard-coded model name, and ignores comments and role names', () => {
  assert.ok(hardCodedModelNames("const m = 'sovereign-default';").length > 0);
  assert.ok(hardCodedModelNames('model: sovereign-reasoning').length > 0);
  assert.ok(hardCodedModelNames("const m = 'openai/gpt-oss-20b';").length > 0);
  assert.ok(hardCodedModelNames("const m = 'Qwen3-VL-235B';").length > 0);
  assert.equal(hardCodedModelNames("// the old sovereign-default\n/* gpt-oss */ const m = 'sovereign-strong';").length, 0);
});
