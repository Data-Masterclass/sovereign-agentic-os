/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    Literal-safety fuzz suite over every user-controlled field of the dbt generator
 * USER STORY: As a domain owner I want whatever anyone types — a name, a description, a column, a
 *             quality rule, a metric label, a sync source or schedule — to reach my dbt project as
 *             text or as a validated identifier, never as a template dbt runs.
 * ARCHITECTURE:
 *   - Corpus + oracle in `literal-fuzz.ts`. For every field × payload: the project must generate
 *     (one bad dataset never breaks the domain), the benign second dataset must still be in it,
 *     the payload must add NO Jinja construct over the same project with every brace removed from
 *     the payload (differential oracle), and `checkProject` rule 8 must report nothing.
 *   - The image half (`images/extensions/dagster/tests/image/literal_safety.py`) runs real
 *     `dbt parse` + `dbt compile` on `fixtures/literal-safety-fuzz.golden.json`, written here.
 *   - The negative twin is `literal-safety.twin.test.ts` (the old single-pass strip put back).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProject, generateProjectReport } from '@tabs/data/lib/dbt/generate';
import { jinjaGrammarIssues } from '@tabs/data/lib/dbt/project-check';
import { isWellFormed } from '@tabs/data/lib/dbt/literal';
import { FIELDS, PAYLOAD_TEMPLATES, baseSnapshot, fuzzProject, newJinja, payloadFor, randomPayloads } from '@tabs/data/lib/dbt/literal-fuzz';

const HERE = dirname(fileURLToPath(import.meta.url));

function render(field: string, value: string): Map<string, string> {
  const s = baseSnapshot();
  FIELDS[field](s, value);
  return generateProject('sales', s);
}

const PAYLOADS = [...PAYLOAD_TEMPLATES, ...randomPayloads(40)];

test('fuzz: no payload in any user-controlled field adds a Jinja construct to the generated project', () => {
  const findings: string[] = [];
  let cases = 0;
  for (const field of Object.keys(FIELDS)) {
    for (const t of PAYLOADS) {
      const value = payloadFor(t, field);
      cases++;
      // The differential twin of the payload: the same text with every brace removed. Every
      // derived name (slug, model path) is identical, so a construct only the payload project has
      // can come from nothing but an input brace.
      const baseline = render(field, value.replace(/[{}]/g, ''));
      let files: Map<string, string>;
      try {
        files = render(field, value);
      } catch (e) {
        findings.push(`${field} ${JSON.stringify(value)}: generation threw (${(e as Error).message})`);
        continue;
      }
      for (const c of newJinja(files, baseline)) findings.push(`${field} ${JSON.stringify(value)}: new Jinja ${c}`);
      for (const i of jinjaGrammarIssues(files)) findings.push(`${field} ${JSON.stringify(value)}: rule 8 ${i.path} ${i.reason}`);
      // Well-formed Unicode in every file (dbt's YAML loader refuses a lone surrogate).
      for (const [p, c] of files) if (!isWellFormed(c)) findings.push(`${field} ${JSON.stringify(value)}: ${p} holds a lone surrogate`);
      // One bad dataset never takes the domain down: the other dataset is still generated.
      const other = field.startsWith('sync.') ? 'ds_orders1' : 'ds_synced1';
      assert.ok([...files.values()].some((c) => c.includes(other)), `${field}: ${other} vanished from the project`);
    }
  }
  assert.ok(cases > 1000, `the corpus is too small (${cases})`);
  assert.deepEqual(findings, [], findings.slice(0, 20).join('\n'));
});

test('fuzz: no ASCII brace from a payload survives in free text; identifiers with one are refused', () => {
  for (const field of Object.keys(FIELDS)) {
    const s = baseSnapshot();
    FIELDS[field](s, "{{ 'LSEVAL' ~ 'UATED' }}");
    const { files, skipped } = generateProjectReport('sales', s);
    const text = [...files.entries()].filter(([p]) => p !== 'os/skipped.yml').map(([, c]) => c).join('\n');
    // The payload either reached the project as encoded text, or its dataset was refused.
    const raw = text.includes("{{ 'LSEVAL'") || text.includes("{% do") || text.includes("{{ 'LSEVAL' ~");
    assert.equal(raw, false, `${field}: the payload reached the project unencoded`);
    if (!text.includes("\uFF5B\uFF5B 'LSEVAL'") && !text.includes("\\007B\\007B ''LSEVAL''")) {
      assert.ok(skipped.length > 0 || !text.includes('LSEVAL'), `${field}: payload neither encoded nor refused`);
    }
  }
});

test('fuzz: free-text fields keep their words (encoded braces), never silently dropped', () => {
  const v = "Revenue {{ 'LSEVAL' ~ 'UATED' }} {}}{ x }%}}";
  for (const field of ['dataset.name', 'dataset.description', 'column.description', 'check.intention', 'measure.label', 'measure.description']) {
    const text = [...render(field, v).values()].join('\n');
    assert.ok(text.includes("\uFF5B\uFF5B 'LSEVAL' ~ 'UATED' \uFF5D\uFF5D"), `${field}: the encoded text is missing`);
  }
});

test('fuzz: an identifier field holding a payload refuses ONLY its dataset, with a typed reason in os/skipped.yml', () => {
  for (const field of ['column.name', 'check.column', 'sync.source.schema', 'sync.source.table', 'sync.connectionId', 'sync.schedule.cron', 'sync.cron.field', 'sync.cursor.column', 'sync.mergeKey', 'dataset.slug', 'dataset.owner', 'upstream.datasetId']) {
    const s = baseSnapshot();
    FIELDS[field](s, "{}}{ 'LSEVAL' ~ 'UATED' }%}}");
    const { files, skipped } = generateProjectReport('sales', s);
    assert.equal(skipped.length, 1, `${field}: expected exactly one refused dataset, got ${JSON.stringify(skipped)}`);
    assert.match(skipped[0].reason, /refused identifier/, field);
    assert.ok(files.get('os/skipped.yml')?.includes(skipped[0].dataset), field);
  }
});

test('a compiled filter literal holding braces keeps its meaning as a Trino Unicode literal', () => {
  const files = render('silver.filter.value', '{a}');
  const sql = [...files.entries()].find(([p]) => p.endsWith('silver_orders.sql'))![1];
  assert.match(sql, /"region" = U&'\\007Ba\\007D'/);
  assert.doesNotMatch(sql.replace(/\{\{ (?:ref|source)\([^}]*\) \}\}/g, ''), /[{}]/);
});

// The image test's input: one project carrying every payload template in every field the image
// can still parse (identifier payloads are refused by the generator and leave their dataset out).
test('golden: literal-safety-fuzz (dbt parse + compile in the Dagster image, literal_safety.py)', () => {
  const golden = join(HERE, 'fixtures', 'literal-safety-fuzz.golden.json');
  const actual = Object.fromEntries(fuzzProject(generateProject));
  if (process.env.REGEN_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(golden, 'utf8')), 'literal-safety-fuzz differs from its golden (REGEN_GOLDEN=1 to accept)');
});

test('rule 8: a bare boolean config value (full_refresh=false) is in the grammar; any other bare word is not', () => {
  const ok = new Map([['models/a.sql', "{{ config(materialized='incremental', unique_key='_batch_id', full_refresh=false) }}\nselect 1"]]);
  assert.deepEqual(jinjaGrammarIssues(ok), []);
  for (const bad of ['full_refresh=False', 'full_refresh=env_var', "full_refresh=false ~ 'x'"]) {
    const files = new Map([['models/a.sql', `{{ config(materialized='table', ${bad}) }}\nselect 1`]]);
    assert.ok(jinjaGrammarIssues(files).length > 0, `${bad} must be outside the grammar`);
  }
});
