/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_KINDS,
  ARTIFACT_OUTPUT_SCHEMA,
  citationArtifact,
  envelope,
  parseArtifacts,
  rowLimitTruncation,
  tableArtifact,
  tableArtifactFromObjectRows,
  truncationBanner,
  truncationOf,
  type ChatArtifact,
} from '@core/runtime/chat-artifacts';

/**
 * FEATURE:    The artifact protocol's round-trip, schema validity and TRUNCATION guard.
 *
 * USER STORY: As a user I must never be shown a confident total computed over a clipped
 *             result set — the single worst thing this feature could do. As an MCP client
 *             author I must be able to validate `structuredContent` against the
 *             `outputSchema` the server advertised.
 *
 * ARCHITECTURE:
 *   Three groups:
 *     (a) TRUNCATION GUARD — `truncated` / `rowLimit` / `message` survive every hop
 *         (mapper → envelope → `parseArtifacts` → banner). These tests are the ones the
 *         plan calls "a guard test that fails if the truncation fields are ever dropped".
 *     (b) ROUND-TRIP per kind — a payload serialised to JSON and parsed back is the same
 *         artifact, and an unknown or malformed kind is DROPPED rather than rendered.
 *     (c) SCHEMA VALIDITY — every payload the six read tools produce validates against
 *         `ARTIFACT_OUTPUT_SCHEMA`, checked by a small structural validator (no new dep).
 */

// A `QueryResult`-shaped value from `core/infra/governed.ts`, clipped at its ceiling.
const CLIPPED = {
  engine: 'trino',
  tables: ['iceberg.sales.gold_orders'],
  columns: ['region', 'net_amount'],
  rows: [
    ['DE', '120.5'],
    ['FR', '90.0'],
  ],
  rowCount: 1000,
  truncated: true,
  rowLimit: 1000,
  message: 'Result clipped at QUERY_MAX_ROWS=1000. These are the first 1000 rows, not a sample.',
};

// ------------------------------------------------- (a) the truncation guard ----

test('C5 GUARD: truncationOf lifts all three fields off a clipped governed result', () => {
  assert.deepEqual(truncationOf(CLIPPED), {
    truncated: true,
    rowLimit: 1000,
    message: CLIPPED.message,
  });
});

test('C5 GUARD: an untruncated result claims nothing — no `truncated: false`', () => {
  assert.deepEqual(truncationOf({ rows: [], rowCount: 0 }), {});
  const a = tableArtifact({ columns: ['x'], rows: [['1']], rowCount: 1 }, { source: 'ad-hoc-sql' });
  assert.equal('truncated' in a, false, 'a non-truncated table must not carry the key at all');
});

test('C5 GUARD: tableArtifact carries truncated, rowLimit and message VERBATIM', () => {
  const a = tableArtifact(CLIPPED, { source: 'ad-hoc-sql', sql: 'select * from orders' });
  assert.equal(a.truncated, true);
  assert.equal(a.rowLimit, 1000);
  assert.equal(a.message, CLIPPED.message, "the query-tool's own sentence must not be paraphrased");
});

test('C5 GUARD: the truncation fields survive the JSON round-trip the wire makes', () => {
  const sent = envelope([tableArtifact(CLIPPED, { source: 'ad-hoc-sql', sql: 'select 1' })]);
  const back = parseArtifacts(JSON.parse(JSON.stringify(sent)));
  assert.equal(back.length, 1);
  const t = back[0];
  assert.equal(t.kind, 'table');
  if (t.kind !== 'table') return;
  assert.equal(t.truncated, true);
  assert.equal(t.rowLimit, 1000);
  assert.equal(t.message, CLIPPED.message);
});

test('C5 GUARD: rowCount is the TOOL-reported count, never the clipped rows.length', () => {
  const a = tableArtifact(CLIPPED, { source: 'ad-hoc-sql' });
  assert.equal(a.rowCount, 1000, 'falling back to rows.length would understate a clipped result');
  assert.equal(a.rows.length, 2);
});

test('C5 GUARD: the banner prefers the tool sentence and never invents a number', () => {
  const withMessage = tableArtifact(CLIPPED, { source: 'ad-hoc-sql' });
  assert.equal(truncationBanner(withMessage), CLIPPED.message);
  // No message from the backend → our own wording, which still names the bound and
  // refuses the aggregate. It never states a row count the backend did not send.
  const noMessage = tableArtifact({ ...CLIPPED, message: undefined }, { source: 'ad-hoc-sql' });
  const banner = truncationBanner(noMessage) ?? '';
  assert.match(banner, /clipped/i);
  assert.match(banner, /1000/);
  assert.match(banner, /FIRST/);
  // And nothing at all when the result was whole — no banner is a claim too.
  assert.equal(truncationBanner(tableArtifact({ rows: [], rowCount: 0 }, { source: 'ad-hoc-sql' })), null);
});

// ------------------------------------------------------ (b) round-trip per kind ----

const SAMPLES: Record<string, ChatArtifact> = {
  table: tableArtifact(CLIPPED, { source: 'ad-hoc-sql', sql: 'select 1', title: 't' }),
  chart: { kind: 'chart', view: 'OrdersV1', panel: { name: 'Revenue', vizType: 'bar' }, title: 'Revenue' },
  metric_draft: { kind: 'metric_draft', datasetId: 'ds_ab12cd', form: { name: 'Revenue', aggregation: 'sum' } },
  dashboard_draft: { kind: 'dashboard_draft', name: 'Sales', view: 'OrdersV1', charts: [{ name: 'a' }], warnings: ['missing member x'] },
  citation: citationArtifact('metric', 'ds_ab12cd.revenue', { name: 'Revenue', tier: 'domain', owner: 'u-42' }),
  clarification: { kind: 'clarification', question: 'Which region?', options: [{ label: 'DE', value: 'DE' }] },
};

test('C8: every declared kind round-trips through JSON and parseArtifacts unchanged', () => {
  for (const kind of ARTIFACT_KINDS) {
    const sample = SAMPLES[kind];
    assert.ok(sample, `no sample for kind ${kind}`);
    const back = parseArtifacts(JSON.parse(JSON.stringify(envelope([sample]))));
    assert.equal(back.length, 1, `kind ${kind} was dropped on parse`);
    assert.deepEqual(back[0], sample, `kind ${kind} did not round-trip`);
  }
});

test('C8: the six kinds are exactly the declared protocol — no parallel family', () => {
  assert.deepEqual([...ARTIFACT_KINDS], [
    'table',
    'chart',
    'metric_draft',
    'dashboard_draft',
    'citation',
    'clarification',
  ]);
});

test('C8: an unknown kind or a malformed artifact is DROPPED, never rendered', () => {
  const parsed = parseArtifacts({
    artifacts: [
      { kind: 'html', markup: '<img src=x onerror=alert(1)>' }, // not a kind we render
      { kind: 'citation' }, // no id
      { kind: 'citation', of: 'nope', id: 'x' }, // not a citable kind
      { kind: 'chart', view: 'V' }, // no panel
      { kind: 'metric_draft', datasetId: 'ds' }, // no form
      { kind: 'dashboard_draft', name: 'n' }, // no view
      { kind: 'clarification', options: [] }, // no question
      'not an object',
      null,
      SAMPLES.citation,
    ],
  });
  assert.deepEqual(parsed, [SAMPLES.citation], 'only the well-formed artifact survives');
});

test('C8: parseArtifacts tolerates every shape of junk without throwing', () => {
  for (const junk of [null, undefined, 0, '', 'x', [], {}, { artifacts: null }, { artifacts: 'x' }]) {
    assert.deepEqual(parseArtifacts(junk), []);
  }
});

test('C8: object-keyed semantic rows become aligned columns, keeping dimension columns', () => {
  const a = tableArtifactFromObjectRows(
    [
      { 'OrdersV1.region': 'DE', 'OrdersV1.revenue': 80210 },
      { 'OrdersV1.region': 'FR', 'OrdersV1.revenue': 48240 },
    ],
    { source: 'semantic-layer', title: 'OrdersV1.revenue', mode: 'live' },
  );
  assert.deepEqual(a.columns, ['OrdersV1.region', 'OrdersV1.revenue']);
  assert.deepEqual(a.rows, [
    ['DE', '80210'],
    ['FR', '48240'],
  ]);
  assert.equal(a.rowCount, 2);
  assert.equal(a.source, 'semantic-layer');
  assert.equal(a.mode, 'live');
});

test('C8: a null cell renders as empty, never as the string "null"', () => {
  const a = tableArtifactFromObjectRows([{ x: null, y: undefined, z: 0 }], { source: 'semantic-layer' });
  assert.deepEqual(a.rows, [['', '', '0']]);
});

test('C6: the source field is what labels an answer ad-hoc, and it is never guessed', () => {
  assert.equal(tableArtifact(CLIPPED, { source: 'ad-hoc-sql' }).source, 'ad-hoc-sql');
  assert.equal(tableArtifact(CLIPPED, { source: 'semantic-layer' }).source, 'semantic-layer');
  // A payload off the wire with a missing/bogus source is treated as ad-hoc — the
  // CAUTIOUS default: an unverified label on a governed number is a cosmetic error, a
  // governed label on an unverified number is a lie.
  const back = parseArtifacts({ artifacts: [{ kind: 'table', columns: [], rows: [], rowCount: 0, source: 'whatever' }] });
  assert.equal(back[0].kind === 'table' && back[0].source, 'ad-hoc-sql');
});

// ------------------------------------------------------- (c) outputSchema validity ----

/**
 * A minimal structural validator for the subset of JSON Schema the artifact schema uses
 * (object/array/string/number/boolean, `enum`, `required`, `items`, `properties`). Kept
 * here rather than pulling in a validator dependency: the schema is ours and small, and a
 * new dependency would need a licence row.
 */
function validate(schema: Record<string, unknown>, value: unknown, path = '$'): string[] {
  const errs: string[] = [];
  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errs.push(`${path}.${req}: required`);
    }
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (props[k]) errs.push(...validate(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
    }
    return errs;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((v, i) => errs.push(...validate(items, v, `${path}[${i}]`)));
    return errs;
  }
  const enumVals = schema.enum as unknown[] | undefined;
  if (enumVals && !enumVals.includes(value)) errs.push(`${path}: ${String(value)} not in enum`);
  if (type === 'string' && typeof value !== 'string') errs.push(`${path}: expected string`);
  if (type === 'number' && typeof value !== 'number') errs.push(`${path}: expected number`);
  if (type === 'boolean' && typeof value !== 'boolean') errs.push(`${path}: expected boolean`);
  return errs;
}

test('C7: every artifact kind validates against the advertised outputSchema', () => {
  for (const kind of ARTIFACT_KINDS) {
    const errs = validate(ARTIFACT_OUTPUT_SCHEMA as unknown as Record<string, unknown>, envelope([SAMPLES[kind]]));
    assert.deepEqual(errs, [], `kind ${kind} does not conform: ${errs.join('; ')}`);
  }
});

test('C7: the schema declares artifacts required and enumerates exactly the six kinds', () => {
  assert.deepEqual(ARTIFACT_OUTPUT_SCHEMA.required, ['artifacts']);
  const items = (ARTIFACT_OUTPUT_SCHEMA.properties.artifacts as { items: { properties: { kind: { enum: string[] } } } }).items;
  assert.deepEqual(items.properties.kind.enum, [...ARTIFACT_KINDS]);
});

test('C7: the schema REJECTS a payload that is not the envelope, so a client can trust it', () => {
  const schema = ARTIFACT_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  assert.notDeepEqual(validate(schema, {}), []);
  assert.notDeepEqual(validate(schema, { artifacts: 'nope' }), []);
  assert.notDeepEqual(validate(schema, { artifacts: [{}] }), []); // no kind
  assert.notDeepEqual(validate(schema, { artifacts: [{ kind: 'html' }] }), []); // not a kind
  assert.notDeepEqual(validate(schema, { artifacts: [{ kind: 'table', rowCount: 'many' }] }), []);
});

// ------------------- (d) H-1: a LIMIT the OS itself compiled is truncation too ----

/**
 * The semantic layer compiles `LIMIT n` into its serve SQL, so it can clip a grouped result
 * exactly as raw SQL can — and `query_metric` used to sum the clipped rows into its scalar.
 * `rowLimitTruncation` is the decision the handler makes; these are its cases.
 */
test('H-1: 400 groups at limit 100 → truncated, with a sentence that forbids a total', () => {
  // The query returned the bound (100 of 400 groups exist). SQL cannot tell us 400; it can
  // only tell us it stopped at 100 — which is exactly why no total may be computed.
  const tr = rowLimitTruncation(100, 100);
  assert.equal(tr.truncated, true);
  assert.equal(tr.rowLimit, 100);
  assert.match(tr.message ?? '', /FIRST 100 rows/);
  assert.match(tr.message ?? '', /A total or average over them would be wrong/);
  assert.match(tr.message ?? '', /cannot report what it did not return/);
});

test('H-1: a result UNDER the bound is not truncated — silence stays meaningful', () => {
  assert.deepEqual(rowLimitTruncation(99, 100), {});
  assert.deepEqual(rowLimitTruncation(0, 100), {});
  assert.deepEqual(rowLimitTruncation(1, 100), {});
});

test('H-1: the ambiguous "exactly n rows" case is treated as POSSIBLY clipped', () => {
  // A query returning exactly `limit` rows is indistinguishable from one clipped at
  // `limit`. Erring toward "clipped" costs a caveat; erring the other way costs a wrong
  // number presented as the governed one.
  assert.equal(rowLimitTruncation(100, 100).truncated, true);
  assert.equal(rowLimitTruncation(5, 5).truncated, true);
});

test('H-1: a nonsensical bound never fabricates a truncation claim', () => {
  assert.deepEqual(rowLimitTruncation(10, 0), {});
  assert.deepEqual(rowLimitTruncation(10, -1), {});
  assert.deepEqual(rowLimitTruncation(10, Number.NaN), {});
  assert.deepEqual(rowLimitTruncation(10, Number.POSITIVE_INFINITY), {});
});

test('H-1: tableArtifactFromObjectRows carries the compiled-LIMIT truncation through', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ 'V.region': `r${i}`, 'V.revenue': 1 }));
  const a = tableArtifactFromObjectRows(rows, {
    source: 'semantic-layer',
    title: 'V.revenue',
    mode: 'live (sql)',
    sql: 'SELECT … LIMIT 100',
    ...rowLimitTruncation(rows.length, 100),
  });
  assert.equal(a.truncated, true, 'the semantic-layer mapper had NO truncation parameters before this fix');
  assert.equal(a.rowLimit, 100);
  assert.match(a.message ?? '', /would be wrong/);
  assert.ok(truncationBanner(a), 'a clipped semantic result must produce a banner');
});

test('M-4: a warning rides the semantic table and is NOT conflated with truncation', () => {
  const a = tableArtifactFromObjectRows([{ x: 1 }], {
    source: 'semantic-layer',
    warning: 'Not sliced by “customer_id” — not exposed on the governed view.',
  });
  assert.match(a.warning ?? '', /Not sliced by/);
  assert.equal('truncated' in a, false, 'a de-dimensioned result is not a clipped one');
  assert.equal(truncationBanner(a), null);
});

// ----------------------------------------- (e) L-1: no field survives by accident ----

test('L-1: parseArtifacts picks fields explicitly — a smuggled html/href/src is dropped', () => {
  const parsed = parseArtifacts({
    artifacts: [
      {
        kind: 'table',
        columns: ['a'],
        rows: [['1']],
        rowCount: 1,
        source: 'semantic-layer',
        // None of these are in the protocol. A spread would have copied them straight
        // through to the renderer's props.
        html: '<img src=x onerror=alert(1)>',
        href: 'javascript:alert(1)',
        src: 'http://evil.test/x.png',
        style: 'position:fixed;inset:0',
        onClick: 'alert(1)',
      },
      {
        kind: 'citation',
        of: 'metric',
        id: 'm',
        href: 'https://evil.test',
        html: '<script>x</script>',
      },
      { kind: 'chart', view: 'V', panel: {}, srcdoc: '<html>' },
      { kind: 'metric_draft', datasetId: 'ds', form: {}, html: '<b>' },
      { kind: 'dashboard_draft', name: 'n', view: 'V', charts: [], href: 'javascript:1' },
    ],
  });
  assert.equal(parsed.length, 5);
  for (const a of parsed) {
    for (const forbidden of ['html', 'href', 'src', 'style', 'onClick', 'srcdoc']) {
      assert.equal(forbidden in a, false, `${a.kind} let a \`${forbidden}\` field survive the parse`);
    }
  }
});

test('L-1: the protocol fields themselves still survive the explicit pick', () => {
  const full = {
    kind: 'table' as const,
    columns: ['a'],
    rows: [['1']],
    rowCount: 9,
    truncated: true as const,
    rowLimit: 9,
    message: 'clipped',
    sql: 'SELECT 1',
    semanticQuery: 'q',
    source: 'semantic-layer' as const,
    mode: 'live',
    title: 't',
    warning: 'w',
  };
  assert.deepEqual(parseArtifacts({ artifacts: [full] }), [full]);
  const draft = {
    kind: 'metric_draft' as const,
    datasetId: 'ds',
    form: { a: 1 },
    previewColumns: ['c'],
    previewRows: [['1']],
    previewMode: 'live (sql)',
    previewSql: 'SELECT 1',
    definitionYaml: 'measures: []',
  };
  assert.deepEqual(parseArtifacts({ artifacts: [draft] }), [draft]);
  const dash = { kind: 'dashboard_draft' as const, id: 'd1', name: 'n', view: 'V', charts: [{ x: 1 }], warnings: ['w'] };
  assert.deepEqual(parseArtifacts({ artifacts: [dash] }), [dash]);
});
