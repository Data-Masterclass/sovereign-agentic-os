/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Parity harness — the dbt model and the TypeScript CTAS must mean the same thing
 * USER STORY: As the person who will flip the flag I want a test that compares, per fixture, the SQL
 *             the OS used to run (`CREATE OR REPLACE TABLE … AS <select>`) with the SQL dbt will run
 *             (the model body with `ref()`/`source()` resolved back to FQNs) — same output columns,
 *             same join shape, same filters — so the switch is a measurement, not a hope
 *             (checklist D15, the gate B4 flips on).
 * ARCHITECTURE:
 *   - WHAT THIS CAN AND CANNOT PROVE. The generator does not RE-COMPILE a composition: the model
 *     body IS the CTAS the OS recorded at build time, with `create … as` stripped and FQNs rewritten
 *     to `ref()`/`source()` (deviation B1-2). So this harness proves the TRANSLATION is faithful and
 *     invertible — same projection, joins, filters and grouping after resolving the Jinja back — and
 *     it catches any future change to the rewriter, the stripper or the planner's lane/FQN mapping.
 *     It does NOT prove that `dbt run` and the old `/execute` produce the same ROWS: that needs two
 *     materialisations and an `EXCEPT ALL` both ways on a cluster, and stays the `kind` half of D15.
 *   - PURE and offline. It compares SQL the OS ITSELF generated: single statement, no comments,
 *     double-quoted identifiers, one space between tokens (`transform.ts`). It is deliberately NOT a
 *     general SQL parser — on anything it does not recognise it reports a mismatch rather than a
 *     pass, so an unparsed shape can never be mistaken for parity.
 *   - What it proves: identical projection (expression AND alias, in order), identical FROM + JOIN
 *     sequence with identical ON predicates, identical WHERE conjuncts (order-insensitive),
 *     identical GROUP BY. Because the projection expressions are compared byte-for-byte after
 *     normalisation, the output TYPES follow — Trino derives them from the same expressions over the
 *     same relations. The physical `DESCRIBE` comparison and the row-set `EXCEPT ALL` both need a
 *     cluster and stay the `kind` half of D15.
 *   - WHERE THE RESOLUTION MAP COMES FROM (B3-review-M-6). `resolveJinja` is the inverse of
 *     `models.rewriteFqns`, but it must NOT be driven by the same plan the rewriter used: a plan
 *     that puts a model in the wrong schema makes both directions agree on the wrong answer and
 *     the comparison passes. So `ref()` resolves to the FQN the OS ITSELF wrote — the target of
 *     that model's own recorded CTAS — and only falls back to the plan for a model the OS never
 *     compiled. And because a wrong lane mapping shows up as a model being reached through
 *     `source()` instead of `ref()` (the rewriter's `modelByFqn` lookup misses, so the FQN is
 *     treated as external), `sourceRefConflicts` reports exactly that as a mismatch. A
 *     consistently-wrong mapping therefore FAILS where it used to pass.
 */
import type { ModelPlan, ModelPlanSet } from '@tabs/data/lib/dbt/models';
import { stripCtas } from '@tabs/data/lib/dbt/models';

export type SelectShape = {
  columns: { expr: string; alias: string | null }[];
  from: string;
  joins: { type: string; rel: string; on: string }[];
  where: string[];
  groupBy: string[];
};

export type ParityResult = {
  /** The fixture this model came from. */
  fixture: string;
  dataset: string;
  model: string;
  ok: boolean;
  /** Empty when `ok`. One line per difference, in the order they were found. */
  mismatches: string[];
  /** Why no comparison was possible (a model with no CTAS to compare against). */
  skipped?: string;
};

const JOIN_RE = /\s(inner|left|right|full|cross)\s+join\s/gi;

/** Collapse the OS's SQL to a comparable form: no comments, single spaces, lower case. */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * `{{ ref('x') }}` / `{{ source('a', 'b') }}` → the FQN the CTAS used. `refs` is built from the
 * recorded CTAS targets where there are any (see the header): ground truth, not the plan the
 * rewriter already used.
 */
export function resolveJinja(sql: string, refs: Map<string, string>, sources: Map<string, string>): string {
  return sql
    .replace(/\{\{\s*ref\(\s*'([^']+)'\s*\)\s*\}\}/g, (whole, name: string) => refs.get(name) ?? whole)
    .replace(/\{\{\s*source\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\}\}/g, (whole, src: string, table: string) => sources.get(`${src}::${table}`) ?? whole);
}

/** Split on `sep` at bracket depth 0 and outside string literals. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Find a top-level keyword's index, or -1. */
function topIndexOf(text: string, keyword: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && text.startsWith(keyword, i)) return i;
  }
  return -1;
}

/**
 * The comparable shape of a single `select`. Returns null when the statement is not one the OS's own
 * compilers produce — a mismatch, never a silent pass.
 */
export function selectShape(sql: string): SelectShape | null {
  const s = normalizeSql(sql);
  if (!s.startsWith('select ')) return null;
  const fromAt = topIndexOf(s, ' from ');
  if (fromAt < 0) return null;
  const projection = s.slice('select '.length, fromAt);
  let rest = s.slice(fromAt + ' from '.length);

  let groupBy: string[] = [];
  const groupAt = topIndexOf(rest, ' group by ');
  if (groupAt >= 0) {
    groupBy = splitTop(rest.slice(groupAt + ' group by '.length), ',');
    rest = rest.slice(0, groupAt);
  }
  let where: string[] = [];
  const whereAt = topIndexOf(rest, ' where ');
  if (whereAt >= 0) {
    where = splitTop(rest.slice(whereAt + ' where '.length), ' and ').sort();
    rest = rest.slice(0, whereAt);
  }

  // FROM + JOINs. `rest` is `<rel> [<type> join <rel> on <pred>]…`; splitting on the capturing
  // JOIN pattern yields relation, type, relation, type, … in source order.
  const joins: { type: string; rel: string; on: string }[] = [];
  const types: string[] = [];
  JOIN_RE.lastIndex = 0;
  const rels = rest.split(JOIN_RE).filter((p, i) => {
    if (i % 2 === 1) {
      types.push(p);
      return false;
    }
    return true;
  });
  const from = rels[0]?.trim() ?? '';
  for (let i = 1; i < rels.length; i++) {
    const seg = rels[i].trim();
    const onAt = topIndexOf(seg, ' on ');
    if (onAt < 0 && types[i - 1] !== 'cross') return null;
    joins.push({
      type: types[i - 1],
      rel: (onAt < 0 ? seg : seg.slice(0, onAt)).trim(),
      on: onAt < 0 ? '' : splitTop(seg.slice(onAt + ' on '.length), ' and ').sort().join(' and '),
    });
  }
  if (!from) return null;

  const columns = splitTop(projection, ',').map((c) => {
    const asAt = topIndexOf(c, ' as ');
    return asAt < 0 ? { expr: c, alias: null } : { expr: c.slice(0, asAt).trim(), alias: c.slice(asAt + ' as '.length).trim() };
  });
  if (columns.length === 0) return null;
  return { columns, from, joins, where, groupBy };
}

function diff(label: string, a: unknown, b: unknown): string | null {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x === y ? null : `${label}: CTAS ${x} vs dbt ${y}`;
}

/**
 * Compare one model against the CTAS the OS recorded for the same layer.
 *
 * SHAPE equality is the contract, not byte equality: `WHERE` conjunct order is semantically
 * irrelevant and asserting the bytes would make a harmless reordering look like drift. Byte
 * equality of the generated project is asserted separately, by the generator goldens.
 */
export function compareSelects(ctasSelect: string, dbtSelect: string): string[] {
  const a = selectShape(ctasSelect);
  const b = selectShape(dbtSelect);
  if (!a) return ['the recorded CTAS is not a shape the harness can read'];
  if (!b) return ['the generated model body is not a shape the harness can read'];
  const out: string[] = [];
  for (const d of [
    diff('output columns', a.columns, b.columns),
    diff('from', a.from, b.from),
    diff('joins', a.joins, b.joins),
    diff('where', a.where, b.where),
    diff('group by', a.groupBy, b.groupBy),
  ]) {
    if (d) out.push(d);
  }
  return out;
}

const CTAS_TARGET_RE = /^\s*create\s+(?:or\s+replace\s+)?table\s+(\S+)\s+as\s+/i;

/** `create or replace table <fqn> as …` → `<fqn>` (normalised), or null. */
export function ctasTarget(sql: string): string | null {
  const m = CTAS_TARGET_RE.exec(normalizeSql(sql));
  return m ? m[1].replace(/"/g, '') : null;
}

/**
 * The FQN maps that invert `rewriteFqns`.
 *
 * `refs` prefers the TARGET of the model's own recorded CTAS — the FQN the OS physically wrote —
 * over `iceberg.<plan schema>.<name>`, so the plan's lane mapping is not used to check itself
 * (B3-review-M-6). `recorded` is the same accessor `parityReport` uses for the CTAS body; a model
 * the OS never compiled has no target and keeps the plan's FQN, which is all that is available.
 */
export function substitutionsFor(
  plan: ModelPlanSet,
  recorded?: (datasetId: string, layer: string) => string | undefined,
): { refs: Map<string, string>; sources: Map<string, string>; modelTargets: Map<string, string> } {
  const refs = new Map<string, string>();
  const modelTargets = new Map<string, string>();
  for (const m of plan.models) {
    const own = recorded?.(m.dataset.id, m.layer);
    const target = own ? ctasTarget(own) : null;
    const fqn = target ?? normalizeSql(`iceberg.${m.schema}.${m.name}`);
    refs.set(m.name, fqn);
    modelTargets.set(fqn, m.name);
  }
  const sources = new Map<string, string>();
  for (const s of plan.sources) sources.set(`${s.source}::${s.table}`, `${s.database ?? 'iceberg'}.${s.schema}.${s.table}`);
  return { refs, sources, modelTargets };
}

/**
 * A relation that IS a model of this project must be reached with `ref()`, never `source()`.
 *
 * `rewriteFqns` keys its model lookup on `<schema>.<table>` as it appears in the recorded CTAS, so
 * when the planner's lane mapping disagrees with what the OS actually wrote, the lookup misses and
 * the model is emitted as an external `source()`. dbt would then build no edge, run the models in
 * the wrong order, and read a table it does not own. The round trip hides it (the same wrong map
 * resolves the source back to the same FQN), so it is asserted here explicitly.
 */
export function sourceRefConflicts(
  body: string,
  sources: Map<string, string>,
  modelTargets: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*source\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\}\}/g)) {
    const fqn = sources.get(`${m[1]}::${m[2]}`);
    if (!fqn) continue;
    const model = modelTargets.get(normalizeSql(fqn).replace(/"/g, ''));
    if (model) out.push(`${fqn} is this project's model "${model}" but is read as source('${m[1]}', '${m[2]}') — the lane mapping disagrees with the FQN the OS wrote`);
  }
  return out;
}

/** The model body with the header comments removed — what dbt will compile. */
export function modelBody(model: ModelPlan): string {
  return model.sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .trim();
}

/**
 * Compare every COMPILED model of a plan against the CTAS recorded for it. A model with no recorded
 * CTAS (a pass-through, a sync landing, a layer the OS never compiled) has nothing to be at parity
 * WITH and is reported as skipped, with the reason — never as a pass.
 */
export function parityReport(fixture: string, plan: ModelPlanSet, artifacts: (datasetId: string, layer: string) => string | undefined): ParityResult[] {
  const { refs, sources, modelTargets } = substitutionsFor(plan, artifacts);
  return plan.models.map((m) => {
    const base = { fixture, dataset: m.dataset.id, model: m.name };
    const ctas = artifacts(m.dataset.id, m.layer);
    if (m.kind !== 'compiled' || !ctas) {
      return { ...base, ok: true, mismatches: [], skipped: `${m.kind} — the OS compiled no CTAS for this layer` };
    }
    const body = modelBody(m);
    const mismatches = [
      ...sourceRefConflicts(body, sources, modelTargets),
      ...compareSelects(stripCtas(ctas), resolveJinja(body, refs, sources)),
    ];
    return { ...base, ok: mismatches.length === 0, mismatches };
  });
}
