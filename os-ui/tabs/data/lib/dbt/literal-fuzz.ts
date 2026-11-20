/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The literal-safety fuzz corpus and oracle — TEST SUPPORT ONLY (imported by
 *             `literal-safety.fuzz.test.ts`, `literal-safety.twin.test.ts`; never by product code)
 * USER STORY: As the owner I want proof that NO user-controlled field can make dbt run code — the
 *             nested delimiter forms included — checked by an oracle that does not trust the
 *             generator's own guard, and twinned so it is shown to catch the old single-pass strip.
 * ARCHITECTURE:
 *   - `PAYLOADS`: Jinja expressions, statements, comments, the nested forms a single-pass strip
 *     reassembles (`{}}{`, `}%}}`, `{}}%`, `%{%}`), `run_query`, `env_var`, `do`, comment and line
 *     breaks (CR, LF, NEL, U+2028, U+2029), quotes, backticks, NUL — plus seeded random strings
 *     over the delimiter alphabet. Each payload carries evaluation markers that never appear
 *     literally: `'LSEVAL' ~ 'UATED'` renders to LSEVALUATED, `run_query` sends `'LSQ' || 'RAN'`.
 *   - `FIELDS`: every user-controlled field the generator reads, each as a mutator on a complete,
 *     otherwise benign snapshot (two datasets, a compiled silver body, a federated sync, metrics).
 *   - Oracle (`newJinja`): the Jinja constructs of the payload project (raw `.sql` text; every
 *     parsed YAML key and string value) must be a sub-multiset of the constructs of the SAME
 *     project with every brace removed from the payload. Any construct the payload adds is a finding. It is
 *     differential on purpose: it does not consult the generator's allow-list.
 */
import yaml from 'js-yaml';
import { emptyVersions, type Dataset } from '@tabs/data/lib/dataset-schema';
import { compileSilver } from '@tabs/data/lib/transform';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

/** Payload templates; `%F` is replaced by the field name so a marker names its field. */
export const PAYLOAD_TEMPLATES: string[] = [
  "{{ 'LSEVAL' ~ 'UATED_%F' }}",
  "{% do log('LSEVAL' ~ 'UATED_%F', info=True) %}",
  "{{ run_query(\"select 'LSQ' || 'RAN_%F'\") }}",
  "{{ env_var('LS_CANARY') }}",
  '{# LS comment %F #}',
  // Nested forms: each re-forms a delimiter if `{{` / `}}` /
  // `{%` / `%}` / `{#` / `#}` are removed in one pass.
  "{}}{ 'LSEVAL' ~ 'UATED_%F' }%}}",
  "{}}% do log('LSEVAL' ~ 'UATED_%F', info=True) %{%}}",
  '{}}{ env_var("LS_CANARY") }%}}',
  "{{{ 'LSEVAL' ~ 'UATED_%F' }}}",
  "{#}{{ 'LSEVAL' ~ 'UATED_%F' }}{#}",
  // Line and comment breaks around a template.
  "x\r\n{{ 'LSEVAL' ~ 'UATED_%F' }}",
  "x\u2028{{ 'LSEVAL' ~ 'UATED_%F' }}\u2029",
  "x\u0085*/ -- {{ 'LSEVAL' ~ 'UATED_%F' }}",
  "' \" ` \\ \u0000 {{ 'LSEVAL' ~ 'UATED_%F' }}",
  // Invalid Unicode: lone surrogates (legal in a JS / JSON string, refused by dbt's YAML loader).
  'x \uD800 y %F',
  'x \uDFFF\uD800 y %F',
  // A nested form that reaches the warehouse: dbt would SEND this query at compile.
  '{}}{ (run_query("select \'LSQ\' || \'RAN_%F\'") if run_query is defined else "") }%}}',
];

/** The nested forms the image project carries in every free-text field. */
export const IMAGE_TEMPLATES = [...PAYLOAD_TEMPLATES.slice(5, 10), PAYLOAD_TEMPLATES[PAYLOAD_TEMPLATES.length - 1]];
/** The twin's: one evaluating nested form and the warehouse one (valid Jinja once re-formed). */
export const TWIN_TEMPLATES = [PAYLOAD_TEMPLATES[5], PAYLOAD_TEMPLATES[PAYLOAD_TEMPLATES.length - 1]];

/** Seeded random strings over the delimiter alphabet (deterministic: the suite never flakes). */
export function randomPayloads(n: number, seed = 0x5eed): string[] {
  const alphabet = ['{', '}', '%', '#', ' ', "'", '"', '\r', '\n', '\u2028', 'a', '-', '*', '/', "'LSEVAL' ~ 'UATED'"];
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let p = '';
    const len = 4 + Math.floor(rnd() * 16);
    for (let j = 0; j < len; j++) p += alphabet[Math.floor(rnd() * alphabet.length)];
    out.push(p);
  }
  return out;
}

const built = (artifact: string | null, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

/** The benign base snapshot every field mutator starts from. Fresh objects on every call. */
export function baseSnapshot(): ProjectSnapshot {
  const silverBody = compileSilver({
    source: 'iceberg.sales.bronze_orders',
    target: 'iceberg.sales.silver_orders',
    columns: ['order_id', 'region', 'net_amount', 'order_date'],
    ops: [{ kind: 'filter', column: 'region', op: '=', value: 'eu' }],
  });
  const orders: Dataset = {
    version: '1',
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description: 'Web-shop orders.',
    grants: [],
    viewNamespaced: true,
    columns: [
      { name: 'order_id', description: 'Order key' },
      { name: 'region', description: 'Sales region' },
      { name: 'net_amount', description: 'Net amount (EUR)' },
      { name: 'order_date', description: 'Order date' },
    ],
    versions: { ...emptyVersions(), bronze: built('bronze/orders.dlt.yml'), silver: built('silver/orders.sql'), gold: built('gold/orders.sql', true) },
    measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Revenue', description: 'Sum of net amount' }],
    checks: [
      { id: 'c1', name: 'Order id present', description: 'Every order has an id', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z', rule: 'not_null', column: 'order_id' },
      { id: 'c2', name: 'Known regions', description: '', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z', rule: 'accepted_values', column: 'region', values: ['eu', 'us'] },
      { id: 'c3', name: 'Review the totals monthly', description: '', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z' },
    ],
  } as unknown as Dataset;
  const synced: Dataset = {
    version: '1',
    id: 'ds_synced1',
    name: 'Synced customers',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description: 'Customers copied from the CRM.',
    grants: [],
    viewNamespaced: true,
    measures: [],
    columns: [{ name: 'id', description: 'Customer key' }, { name: 'updated_at', description: 'Last change' }],
    versions: { ...emptyVersions(), bronze: built('bronze/customers.sql') },
    sync: {
      connectionId: 'conn-crm',
      source: { schema: 'crm', table: 'customers' },
      mode: 'merge',
      mergeKeys: ['id'],
      cursor: { kind: 'timestamp', column: 'updated_at' },
      schedule: { cron: '0 6 * * *' },
      enabled: true,
    },
  } as unknown as Dataset;
  return {
    domain: 'sales',
    datasets: [
      { dataset: orders, artifacts: { 'silver/orders.sql': silverBody }, compiled: ['silver/orders.sql'] },
      { dataset: synced, artifacts: {} },
    ],
    catalogs: { 'conn-crm': 'crm_pg' },
  } as unknown as ProjectSnapshot;
}

type Mutator = (s: ProjectSnapshot, v: string) => void;
const orders = (s: ProjectSnapshot) => s.datasets[0].dataset as Dataset & Record<string, unknown>;
const synced = (s: ProjectSnapshot) => s.datasets[1].dataset as Dataset & Record<string, unknown>;

/** Every user-controlled field the dbt generator reads. */
export const FIELDS: Record<string, Mutator> = {
  'dataset.name': (s, v) => { orders(s).name = `Orders ${v}`; },
  'dataset.description': (s, v) => { orders(s).description = v; },
  'dataset.slug': (s, v) => { orders(s).slug = v; },
  'dataset.owner': (s, v) => { orders(s).owner = v; },
  'dataset.domain': (s, v) => { orders(s).domain = v; },
  'dataset.id': (s, v) => { orders(s).id = `ds_${v}`; },
  'column.name': (s, v) => { orders(s).columns[1].name = v; },
  'column.description': (s, v) => { orders(s).columns[0].description = v; },
  'check.name': (s, v) => { orders(s).checks![0].name = v; },
  'check.intention': (s, v) => { orders(s).checks![2].name = v; },
  'check.description': (s, v) => { orders(s).checks![0].description = v; },
  'check.column': (s, v) => { orders(s).checks![0].column = v; },
  'check.value': (s, v) => { orders(s).checks![1].values = ['eu', v]; },
  'check.toDataset': (s, v) => { Object.assign(orders(s).checks![0], { rule: 'reference', toDataset: v, toColumn: 'id' }); },
  'check.toColumn': (s, v) => { Object.assign(orders(s).checks![0], { rule: 'reference', toDataset: 'ds_synced1', toColumn: v }); },
  'measure.name': (s, v) => { orders(s).measures[0].name = v; },
  'measure.label': (s, v) => { (orders(s).measures[0] as { label?: string }).label = v; },
  'measure.description': (s, v) => { (orders(s).measures[0] as { description?: string }).description = v; },
  'measure.sql': (s, v) => { orders(s).measures[0].sql = v; },
  'measure.filter': (s, v) => { (orders(s).measures[0] as { filters?: { sql: string }[] }).filters = [{ sql: `{CUBE}.region = '${v}'` }]; },
  'upstream.datasetId': (s, v) => { orders(s).upstreams = [{ datasetId: v } as never]; },
  'silver.filter.value': (s, v) => {
    s.datasets[0].artifacts['silver/orders.sql'] = compileSilverOrRaw(v);
  },
  'sync.source.schema': (s, v) => { synced(s).sync!.source.schema = v; },
  'sync.source.table': (s, v) => { synced(s).sync!.source.table = v; },
  'sync.connectionId': (s, v) => {
    synced(s).sync!.connectionId = v;
    (s.catalogs as Record<string, string | null>)[v] = 'crm_pg';
  },
  // A connection whose catalog did not resolve: its id is written into the dbt source (name, meta).
  // A resolved one reaches only the dlt asset in data/dagster/definitions.py (its own fuzz suite).
  'sync.connectionId.unresolved': (s, v) => {
    synced(s).sync!.connectionId = v;
    (s.catalogs as Record<string, string | null>)[v] = null;
  },
  'sync.schedule.cron': (s, v) => { synced(s).sync!.schedule.cron = v; },
  'sync.cron.field': (s, v) => { synced(s).sync!.schedule.cron = `0 6 * * ${v}`; },
  'sync.cursor.column': (s, v) => { synced(s).sync!.cursor!.column = v; },
  'sync.mergeKey': (s, v) => { synced(s).sync!.mergeKeys = [v]; },
  'sync.owner': (s, v) => { synced(s).owner = v; },
};

/** A compiled silver body whose filter literal carries `v` (the OS compiler's own output). */
function compileSilverOrRaw(v: string): string {
  try {
    return compileSilver({
      source: 'iceberg.sales.bronze_orders',
      target: 'iceberg.sales.silver_orders',
      columns: ['order_id', 'region', 'net_amount', 'order_date'],
      ops: [{ kind: 'filter', column: 'region', op: '=', value: v }],
    });
  } catch {
    // The compiler refuses comment / `;` tokens itself; the stored body is then the raw form a
    // hand edit could leave behind — the generator must still keep it Jinja-free.
    return `create or replace table iceberg.sales.silver_orders as select "order_id", "region" from iceberg.sales.bronze_orders where "region" = '${v.replace(/'/g, "''")}'`;
  }
}

/** One payload instance for a field. */
export function payloadFor(template: string, field: string): string {
  return template.replace(/%F/g, field.replace(/[^A-Za-z0-9]/g, '_'));
}

const CONSTRUCT = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;

function yamlStrings(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) yamlStrings(v, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.push(k);
      yamlStrings(v, out);
    }
  }
}

/** Every Jinja construct dbt would see in the project, as a multiset (construct → count). */
export function jinjaConstructs(files: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (c: string) => counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const [path, content] of files) {
    const texts: string[] = [];
    if (path.endsWith('.yml') || path.endsWith('.yaml')) {
      try {
        yamlStrings(yaml.load(content), texts);
      } catch {
        texts.push(content);
      }
    } else texts.push(content);
    for (const t of texts) {
      for (const m of t.matchAll(CONSTRUCT)) add(`${path}::${m[0]}`);
      // A lone delimiter opener is a construct too (dbt would refuse or render it).
      const openers = (t.match(/\{[{%#]/g) ?? []).length;
      const matched = [...t.matchAll(CONSTRUCT)].length;
      for (let i = matched; i < openers; i++) add(`${path}::<unterminated opener>`);
    }
  }
  return counts;
}

/** The constructs `payload` adds over `baseline` (empty = the payload stayed text). */
export function newJinja(payload: Map<string, string>, baseline: Map<string, string>): string[] {
  const a = jinjaConstructs(payload);
  const b = jinjaConstructs(baseline);
  const out: string[] = [];
  for (const [c, n] of a) if (n > (b.get(c) ?? 0)) out.push(c);
  return out;
}

/** Every evaluation marker that, if found in dbt output, proves a payload was executed. */
export const EVAL_MARKERS = ['LSEVALUATED', 'LSQRAN', 'ls-canary-value'];

/**
 * The image fuzz project: the free-text payloads in every free-text field at once, plus a refused
 * identifier payload on a THIRD dataset (so the image also sees a domain that loses one dataset).
 * Shared by the fuzz golden and the twin, which renders it with the legacy strip put back and ONE
 * nested form per field (several re-formed templates in one string are a Jinja syntax error, which
 * would stop dbt before it evaluates anything and prove nothing).
 */
export function fuzzProject(
  gen: (domain: string, s: ProjectSnapshot) => Map<string, string>,
  templates: string[] = IMAGE_TEMPLATES,
  /** A lone surrogate in the name (the image must still parse the project). Off for the twin, so
   *  its parse reaches the templates instead of stopping at the YAML loader. */
  surrogate = true,
): Map<string, string> {
  const s = baseSnapshot();
  const o = s.datasets[0].dataset;
  const nested = (f: string) => templates.map((t) => payloadFor(t, f)).join(' ');
  o.slug = 'orders'; // a renamed dataset: the physical name stays put while the name carries payloads
  o.name = `Orders ${surrogate ? '\uD800 ' : ''}${nested('name')}`;
  o.description = `${nested('description')} ${payloadFor(PAYLOAD_TEMPLATES[2], 'description')} ${payloadFor(PAYLOAD_TEMPLATES[3], 'description')}`;
  o.columns[0].description = nested('coldesc');
  o.checks![2].name = nested('intention');
  (o.measures[0] as { label?: string }).label = `Revenue ${nested('label')}`;
  (o.measures[0] as { description?: string }).description = nested('mdesc');
  s.datasets[1].dataset.description = `${payloadFor(PAYLOAD_TEMPLATES[11], 'syncdesc')}`;
  const third = structuredClone(s.datasets[1]);
  third.dataset.id = 'ds_refused1';
  third.dataset.name = 'Refused';
  third.dataset.sync!.source.table = `customers ${nested('table')}`;
  s.datasets.push(third);
  return gen('sales', s);
}
