/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    Free text survives a git push → read-back → regenerate round trip exactly
 * USER STORY: As an engineer who edits `schema.yml` in git I want my description to come back
 *             as I wrote it — fullwidth braces included — and not to grow by one generated
 *             sentence on every push.
 * ARCHITECTURE:
 *   - Pure: `literal.freeText` / `decodeFreeText` (injective encoding), `schema.authoredDescription`
 *     and the real git read-back parser `datasetsFromSchemaYml`, over the real generator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFreeText, freeText } from '@tabs/data/lib/dbt/literal';
import { authoredDescription } from '@tabs/data/lib/dbt/schema';
import { datasetsFromSchemaYml } from '@tabs/data/lib/dbt/ingest';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import { baseSnapshot } from '@tabs/data/lib/dbt/literal-fuzz';
import type { Dataset } from '@tabs/data/lib/dataset-schema';

const FW_O = '\uFF5B';
const FW_C = '\uFF5D';
const MARK = '\u2060';

test('freeText is injective: decode(encode(x)) === x, the author\'s fullwidth braces and markers included', () => {
  const cases = ['', '{x}', `${FW_O}x${FW_C}`, `{${FW_O}}${FW_C}`, `${FW_O}${MARK}`, `{${MARK}`, `${MARK}${MARK}${MARK}`, `a${FW_O}${MARK}${MARK}{b`, '{{ x }} \uFF5B\uFF5B y \uFF5D\uFF5D'];
  for (const c of cases) {
    const enc = freeText(c);
    assert.doesNotMatch(enc, /[{}]/, JSON.stringify(c));
    assert.equal(decodeFreeText(enc), c, JSON.stringify(c));
  }
  // Seeded random strings over the ambiguous alphabet.
  const alphabet = ['{', '}', FW_O, FW_C, MARK, 'a', ' '];
  let s = 7;
  for (let n = 0; n < 2000; n++) {
    let x = '';
    for (let j = 0; j < 12; j++) x += alphabet[(s = (Math.imul(s, 1103515245) + 12345) >>> 0) % alphabet.length];
    assert.equal(decodeFreeText(freeText(x)), x, JSON.stringify(x));
  }
  // The common case reads exactly as before: an ASCII brace becomes one fullwidth brace.
  assert.equal(freeText('{a}'), `${FW_O}a${FW_C}`);
});

function schemaOf(files: Map<string, string>): [string, string] {
  return [...files.entries()].find(([p]) => p === 'models/silver/schema.yml')!;
}

test('git round trip: only the author\'s description is stored, and push → regenerate is stable', () => {
  const s = baseSnapshot();
  const d = s.datasets[0].dataset as Dataset;
  d.description = `Revenue {per} region ${FW_O}fullwidth${FW_C}`;
  const first = generateProject('sales', s);
  for (let push = 0; push < 3; push++) {
    const [path, content] = schemaOf(generateProject('sales', s));
    const back = datasetsFromSchemaYml(path, content, 'sales')[0];
    const own = decodeFreeText(authoredDescription(back.rawDescription, d, back.layer));
    assert.equal(own, `Revenue {per} region ${FW_O}fullwidth${FW_C}`, `push ${push}: the author's exact text`);
    assert.equal(back.description, own, 'the generic strip agrees with the exact one');
    d.description = own; // what setDocs stores
  }
  assert.deepEqual(generateProject('sales', s), first, 'three pushes later the project is byte-identical');
});

test('a description that already grew is cleaned back to the author\'s words', () => {
  const s = baseSnapshot();
  const d = s.datasets[0].dataset as Dataset;
  const sentence = `silver layer of OS dataset ${d.id} ("${d.name}").`;
  assert.equal(authoredDescription(`${sentence} ${sentence} ${sentence} Web orders.`, d, 'silver'), 'Web orders.');
  assert.equal(authoredDescription(`gold layer of OS dataset ds_old1 ("Old name"). ${sentence} Web orders.`), 'Web orders.');
  assert.equal(authoredDescription('An engineer wrote this.'), 'An engineer wrote this.');
});
