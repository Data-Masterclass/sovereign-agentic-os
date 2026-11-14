/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tripwire — no agent- or user-facing text claims Cube serves or secures a number
 * USER STORY: As an engineer reading what the OS tells an agent I want it to describe what actually
 *             runs: a dbt metric compiled to one governed Trino SELECT as the viewer. Cube is not
 *             on the read path and has not been since the engine rebuild (checklist M13).
 * ARCHITECTURE:
 *   - Reads the FILES as text, from the repo, so the tripwire covers prose an import would not
 *     reach (`context.md`, `guide.md`, `README.md`) as well as the tool descriptions.
 *   - Code COMMENTS are allowed to mention Cube: they are the historical record of why the shapes
 *     look the way they do, and rewriting them would erase it (M-R12.1 says so explicitly). So
 *     `.ts`/`.tsx` files are stripped of comments first, and what remains — string literals,
 *     identifiers, JSX text — must be Cube-free, with ONE named exception: the `{CUBE}.` filter
 *     placeholder persisted inside `Measure.filters[].sql`, which is a real stored value in every
 *     existing tenant's data and cannot be renamed without a migration.
 *   - Scope: this tab, the metric tools AND `tabs/dashboards/**`. Iteration 2 cleared the 27
 *     Cube claims the dashboards tab still carried (its guide, its agent context, its lib README
 *     and the UI/store comments that described the bound view in the present tense as a Cube
 *     view), so the tab is in the tripwire rather than in a report as a cross-stream need. The
 *     stale README rows for `cube-meta.ts` and `/api/dashboards/cube-meta` went with them: both
 *     were deleted long ago, so the page documented two things that do not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Files whose PROSE is read by a user or an agent. */
const PROSE = [
  'tabs/metrics/context.md',
  'tabs/metrics/guide.md',
  'tabs/metrics/README.md',
  // Stream X filed these as X-4/X-6: the Data tab's agent context pointed at `/api/cube/models`,
  // a route that does not exist, and described the semantic layer as Cube's. Fixed with the metric
  // text because it IS metric text; `tabs/data/guide.md` is left to the stream that owns it.
  'tabs/data/context.md',
  // Iteration 2 (M13 + X9): the dashboards tab's own user- and agent-facing prose.
  'tabs/dashboards/guide.md',
  'tabs/dashboards/context.md',
  'tabs/dashboards/lib/README.md',
];

/** Trees whose non-comment source must be Cube-free. */
const TREES = ['tabs/metrics', 'core/mcp', 'tabs/dashboards'];

/**
 * The names that legitimately survive, because they identify a STORED artefact rather than making
 * a claim: the `{CUBE}.` placeholder persisted inside `Measure.filters[].sql` (real data in every
 * existing tenant — renaming it needs a migration, not an edit), the cube-shaped YAML door's
 * parser keys, and the cube artefact's own path helpers.
 */
const ALLOWED = [
  /\\?\{CUBE\\?\}\\?\./g, // `{CUBE}.` and its regex-escaped spelling `\{CUBE\}\.`
  /CUBE_ARTIFACT/g,
  /scaffoldMetricYaml/g,
  /\bcubes\b/g, // the `cubes:` key of the stored cube YAML the YAML door parses
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip block and line comments. Crude but sufficient: it only ever removes MORE text. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

test('M13: no user- or agent-facing PROSE claims Cube serves or secures a number', () => {
  for (const rel of PROSE) {
    const text = readFileSync(join(UI, rel), 'utf8');
    assert.doesNotMatch(text, /cube/i, `${rel} still mentions Cube — it is not on the read path`);
  }
});

test('M13: no string, identifier or JSX text under tabs/metrics, core/mcp or tabs/dashboards mentions Cube', () => {
  const offenders: string[] = [];
  for (const tree of TREES) {
    for (const file of walk(join(UI, tree))) {
      let body = stripComments(readFileSync(file, 'utf8'));
      for (const ok of ALLOWED) body = body.replace(ok, '');
      for (const m of body.matchAll(/^.*cube.*$/gim)) offenders.push(`${relative(UI, file)}: ${m[0].trim().slice(0, 140)}`);
    }
  }
  assert.deepEqual(offenders, [], `Cube in non-comment source:\n${offenders.join('\n')}`);
});

test('M13: the honest claim IS made — the metric prose names dbt, Trino and the viewer', () => {
  const context = readFileSync(join(UI, 'tabs/metrics/context.md'), 'utf8');
  assert.match(context, /dbt metric/i);
  assert.match(context, /models\/semantic\/<model>\.yml/);
  assert.match(context, /Trino/);
  assert.match(context, /OPA/);
  assert.match(context, /MetricFlow is never on the request path/);
});
