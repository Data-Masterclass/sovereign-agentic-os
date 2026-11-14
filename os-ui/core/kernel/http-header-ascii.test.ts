/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel / HTTP hygiene
 * FEATURE:    Tripwire — HTTP header literals in route handlers must be ASCII
 * USER STORY: As a maintainer I want a route that sets a response header with a non-Latin-1
 *             character (an em-dash in a WWW-Authenticate realm, 2026-11-14) to fail in CI, not
 *             in production, where the fetch runtime threw "Cannot convert argument to a
 *             ByteString" and turned every 401 into a 500 behind the ingress auth sub-request.
 * ARCHITECTURE:
 *   - Text scan of every `app/api/** /route.ts`: a line that names a well-known response header
 *     and contains a quoted literal with a code point above U+007F is an offence.
 *   - Deliberately regex-light: Node's TypeScript stripper misparses regex literals that contain
 *     backticks or `\xNN` classes, so literals are extracted with a small character scanner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e === 'route.ts') out.push(p);
  }
  return out;
};

const HEADER_NAMES = ['www-authenticate', 'content-type', 'location', 'retry-after', 'set-cookie', 'cache-control', 'content-disposition'];
const namesHeader = (line: string): boolean => {
  const l = line.toLowerCase();
  return HEADER_NAMES.some((h) => l.includes(`'${h}'`) || l.includes(`"${h}"`)) || /['"]x-[a-z0-9-]+['"]/i.test(l);
};

/** Quoted literals on one line: '...', "..." and template strings. */
const quotedLiterals = (line: string): string[] => {
  const out: string[] = [];
  const quotes = new Set(["'", '"', String.fromCharCode(96)]);
  let i = 0;
  while (i < line.length) {
    const q = line[i];
    if (quotes.has(q)) {
      const end = line.indexOf(q, i + 1);
      if (end < 0) break;
      out.push(line.slice(i, end + 1));
      i = end + 1;
    } else i += 1;
  }
  return out;
};
const nonAscii = (s: string): boolean => Array.from(s).some((c) => (c.codePointAt(0) ?? 0) > 0x7f);
const stripComments = (line: string): string => line.replace(/\/\*[^*]*\*\//g, '').replace(/\/\/.*$/, '');

test('no route sets a response header literal containing a non-ASCII character', () => {
  const offenders: string[] = [];
  for (const f of walk(join(process.cwd(), 'app', 'api'))) {
    readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
      const line = stripComments(raw);
      if (!namesHeader(line)) return;
      if (quotedLiterals(line).some(nonAscii)) offenders.push(`${f.replace(process.cwd() + '/', '')}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `non-ASCII in a header literal (fetch ByteString rule):\n${offenders.join('\n')}`);
});
