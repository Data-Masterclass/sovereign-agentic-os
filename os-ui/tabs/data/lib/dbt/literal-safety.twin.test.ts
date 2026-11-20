/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    NEGATIVE TWIN of the literal-safety fuzz suite — the old single-pass strip put back
 * USER STORY: As the owner I want proof that the fuzz suite would have caught the defect it guards
 *             against: with the generator's free-text encoder replaced by the pre-fix
 *             `stripJinja` (verbatim) and identifier validation switched off, the same corpus and
 *             the same oracle MUST report findings.
 * ARCHITECTURE:
 *   - `literal.ts` is module-mocked BEFORE the generator loads: `freeText` / `commentText` become
 *     the legacy single-pass strip, `datasetLiteralIssues` returns nothing, `jinjaFreeSql` passes
 *     the body through. Everything else is the real module.
 *   - Writes `fixtures/literal-safety-legacy-twin.json` (NOT a `.golden.json`, so the must-parse
 *     image tests skip it): the image twin in `literal_safety.py` must SEE the payload execute.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pre-fix emitter, verbatim (emit.ts before this change). */
function legacyStripJinja(text: string): string {
  return String(text ?? '').replace(/\{\{|\}\}|\{%|%\}|\{#|#\}/g, '');
}
const legacyComment = (s: unknown) => legacyStripJinja(String(s ?? '')).replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, ' ');

const real = await import('@tabs/data/lib/dbt/literal');
mock.module('@tabs/data/lib/dbt/literal', {
  namedExports: {
    ...real,
    freeText: legacyStripJinja,
    commentText: legacyComment,
    datasetLiteralIssues: () => [],
    jinjaFreeSql: (body: string) => body,
  },
});
const generate = await import('@tabs/data/lib/dbt/generate');
const { generateProject } = generate;
const { FIELDS, PAYLOAD_TEMPLATES, TWIN_TEMPLATES, baseSnapshot, fuzzProject, newJinja, payloadFor } = await import('@tabs/data/lib/dbt/literal-fuzz');

const HERE = dirname(fileURLToPath(import.meta.url));
const noCheck = { check: () => [] };

test('twin: with the legacy strip, the fuzz oracle finds Jinja the payloads created (the suite would FAIL)', () => {
  const hits = new Set<string>();
  for (const field of Object.keys(FIELDS)) {
    for (const t of PAYLOAD_TEMPLATES) {
      const v = payloadFor(t, field);
      const a = baseSnapshot();
      FIELDS[field](a, v);
      const b = baseSnapshot();
      FIELDS[field](b, v.replace(/[{}]/g, ''));
      try {
        if (newJinja(generateProject('sales', a, noCheck), generateProject('sales', b, noCheck)).length) hits.add(field);
      } catch {
        hits.add(field); // the legacy generator cannot even render it: also a failure of the suite
      }
    }
  }
  // The nested forms re-form delimiters in EVERY field the old strip covered, and the
  // fields it never covered carry raw templates.
  for (const f of ['dataset.name', 'dataset.description', 'column.description', 'check.intention', 'measure.label', 'measure.description', 'sync.source.table', 'sync.schedule.cron', 'sync.connectionId', 'column.name']) {
    assert.ok(hits.has(f), `the twin did not catch ${f}: the oracle is blind`);
  }
});

test('twin: with the legacy strip, the generator guard (rule 8) still leaves the dataset out', () => {
  const s = baseSnapshot();
  FIELDS['dataset.name'](s, payloadFor(PAYLOAD_TEMPLATES[5], 'name'));
  const { generateProjectReport } = generate;
  const { files, skipped } = generateProjectReport('sales', s);
  assert.deepEqual(skipped.map((x) => x.dataset), ['ds_orders1'], 'the defence-in-depth guard did not catch the re-formed template');
  assert.match(skipped[0].reason, /Jinja outside the generator.s grammar/);
  assert.ok(![...files.values()].some((c) => c.includes("{{ 'LSEVAL'")));
});

test('twin fixture: literal-safety-legacy-twin.json (the image twin must see the payload execute)', () => {
  const path = join(HERE, 'fixtures', 'literal-safety-legacy-twin.json');
  const actual = Object.fromEntries(fuzzProject((d, s) => generateProject(d, { ...s, datasets: s.datasets.filter((e) => e.dataset.id !== 'ds_refused1') }, noCheck), TWIN_TEMPLATES, false));
  if (process.env.REGEN_GOLDEN === '1' || !existsSync(path)) writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')), 'the twin fixture differs (REGEN_GOLDEN=1 to accept)');
  // The reassembled delimiters really are in it.
  assert.ok(Object.values(actual).some((c) => c.includes("{{ 'LSEVAL' ~ 'UATED_")), 'the twin fixture carries no live template');
});
