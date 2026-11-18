/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core/kernel
 * FEATURE:    Source files stay TEXT — no raw control bytes
 * USER STORY: As a reviewer I want every diff to be readable; a file git calls binary hides its
 *             changes from review, from `git diff` and from every grep-based tripwire we rely on.
 * ARCHITECTURE:
 *   - Greps every `.ts`/`.tsx` under `core/`, `tabs/`, `app/` and `worker/` for a byte below
 *     0x09 (NUL through BACKSPACE). Tab (0x09), LF (0x0a) and CR (0x0d) are left alone; so are
 *     bytes 0x0b/0x0c, which no editor emits by accident and which would be a separate decision.
 *   - Why this exists: two files in this repo carried a literal NUL inside a template literal
 *     and a regex — `${scope}<NUL>${path}` and `/[<NUL>-<US>]/` — where the AUTHOR meant the
 *     two-character escapes `\\0` and `\\x00-\\x1f`. Git then treated the files as binary, so
 *     the review of a grant-scoping change could not see the lines it had to judge.
 *   - WHAT THIS DOES NOT GUARANTEE: it sees control bytes, not "readable source". A file can be
 *     perfectly text and still be unreviewable (minified, 4000-column lines, mojibake). It also
 *     does not look at non-source assets, or at bytes 0x0b-0x1f.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['core', 'tabs', 'app', 'worker'];
/** Bytes that may appear: everything from TAB up. Below TAB is never typed on purpose. */
const LOWEST_ALLOWED = 0x09;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

test('SOURCE-TEXT: no .ts/.tsx file carries a raw control byte below 0x09', () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sources(join(process.cwd(), root))) {
      const buf = readFileSync(file);
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] < LOWEST_ALLOWED) {
          const line = buf.subarray(0, i).toString('utf8').split('\n').length;
          offenders.push(`${file}:${line} byte 0x${buf[i].toString(16).padStart(2, '0')}`);
          break;
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'write the ESCAPE (`\\0`, `\\x00`), never the byte — a file with control bytes is binary to git:\n'
      + offenders.join('\n'),
  );
});
