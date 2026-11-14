/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel / boot
 * FEATURE:    Edge-compile guard for the Next.js instrumentation hook
 * USER STORY: As a maintainer I want `next build` to stay green when a boot step imports a
 *             Node-only module, because `middleware.ts` makes Next compile `instrumentation.ts`
 *             for the edge runtime too, and webpack only skips dependencies that sit INSIDE an
 *             `if (process.env.NEXT_RUNTIME === 'nodejs') { ... }` block — never code that merely
 *             follows an early `return`. PR #48's CI `build` job failed exactly this way.
 * ARCHITECTURE:
 *   - Pure text analysis of the boot file: walks brace depth and asserts every `await import(`
 *     is enclosed by a block opened with the runtime guard. No module is executed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GUARD = /^\s*if \(process\.env\.NEXT_RUNTIME === 'nodejs'\) \{\s*$/;

test('every dynamic import in instrumentation.ts sits inside a NEXT_RUNTIME === nodejs block', () => {
  const src = readFileSync(join(process.cwd(), 'instrumentation.ts'), 'utf8');
  const lines = src.split('\n');
  const stack: boolean[] = []; // one entry per open `{`: true when that block is a runtime guard
  const offenders: string[] = [];
  let inBlockComment = false;
  lines.forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const start = line.indexOf('/*');
    if (start >= 0) {
      const end = line.indexOf('*/', start + 2);
      if (end < 0) { inBlockComment = true; line = line.slice(0, start); } else { line = line.slice(0, start) + line.slice(end + 2); }
    }
    const codeOnly = line.replace(/\/\/.*$/, '').replace(/`[^`]*`|'[^']*'|"[^"]*"/g, (m) => (m.includes('import(') ? m : ''));
    if (/await import\(/.test(codeOnly) && !stack.includes(true)) offenders.push(`${i + 1}: ${raw.trim()}`);
    const isGuard = GUARD.test(raw);
    for (const ch of codeOnly) {
      if (ch === '{') stack.push(isGuard);
      else if (ch === '}') stack.pop();
    }
  });
  assert.deepEqual(offenders, [], `dynamic imports outside a runtime-guard block:\n${offenders.join('\n')}`);
});
