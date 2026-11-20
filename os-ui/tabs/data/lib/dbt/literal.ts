/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Literal safety for the generated dbt project — strict identifiers, a strict cron
 *             grammar, and free text that can never become a Jinja template
 * USER STORY: As a domain owner I want every name, description and schedule I type to land in my
 *             domain's dbt project as plain text and plain identifiers, never as code dbt runs.
 * ARCHITECTURE:
 *   - dbt renders every model `.sql` file and (almost) every string value of every properties
 *     `.yml` file through Jinja; descriptions are rendered later, in docs processing, but rendered
 *     all the same (dbt-core `parser/schema_renderer.py`; docs: "Jinja & macros", "description",
 *     "Using docs blocks" — pinned in components/dbt/UPSTREAM.md). So there are exactly two safe
 *     ways for user input to reach those files, and this module is both of them:
 *       1. IDENTIFIERS (dataset ids, domains, principals, connection ids, Trino schema / table /
 *          column names, slugs) are VALIDATED against closed allow-list patterns. A value that
 *          does not match is REFUSED with a typed `LiteralSafetyError` — never cleaned up.
 *       2. FREE TEXT (names, descriptions, labels, rule names) is ENCODED by `freeText()`: the two
 *          ASCII braces become their fullwidth forms U+FF5B / U+FF5D. Every Jinja construct starts
 *          with an ASCII `{` (`{{`, `{%`, `{#`; dbt configures no line-statement prefix), so text
 *          that contains no ASCII `{` is a single Jinja data token whatever else it holds. The
 *          fullwidth braces read as braces in the YAML, the manifest and the dbt docs site, and
 *          `decodeFreeText()` maps them back. This is a proof, not a blacklist: no sequence of
 *          input characters can produce an ASCII `{` in the output.
 *   - The generator calls `datasetLiteralIssues()` for every dataset before it renders anything
 *     and leaves a failing dataset out of the project (reported in `os/skipped.yml`), so a record
 *     written before these rules — or edited by hand — can never reach dbt. The store refuses the
 *     same values at write time (defence in depth).
 *   - Cron: `core/kernel/cron-util.isValidCron()` accepts only the strict 5-field grammar.
 */
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { isValidCron } from '@core/kernel/cron-util';

export type IdentifierKind = 'sql' | 'column' | 'dataset_id' | 'domain' | 'principal' | 'connection_id' | 'slug';

/** A refused identifier or cron expression, with the field it came from. */
export class LiteralSafetyError extends Error {
  readonly code: 'invalid_identifier' | 'invalid_cron';
  readonly field: string;
  readonly value: string;
  /** The OS dataset whose input was refused, when known (the generator skips that dataset). */
  datasetId?: string;
  constructor(code: 'invalid_identifier' | 'invalid_cron', field: string, value: string, message: string) {
    super(message);
    this.name = 'LiteralSafetyError';
    this.code = code;
    this.field = field;
    this.value = value;
  }
}

/**
 * The closed allow-lists. Every pattern is anchored and excludes braces, quotes, backslashes,
 * whitespace and control characters, so none of these values can open a Jinja construct, leave a
 * SQL or Jinja string literal, or end a `--` comment.
 */
export const IDENTIFIER_PATTERNS: Record<IdentifierKind, RegExp> = {
  /** A Trino column / schema / table name usable unquoted (128 = a safe bound below Trino's). */
  sql: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
  /**
   * A PHYSICAL column name. New uploads land under `normalizeColumnName` identifiers, but a
   * table can already hold a header such as `Order Date` or `größe`; such a name is kept as it is
   * (never renamed, never dropped) and emitted with dbt's `quote: true`. It may hold no brace,
   * double quote, backslash, control character, line or paragraph separator or lone surrogate,
   * and no leading or trailing whitespace — so it can neither open Jinja nor leave a quoted
   * Trino identifier.
   */
  column: /^(?=[^\s])(?=[\s\S]*[^\s]$)[^\u0000-\u001f\u007f-\u009f{}"\\\u2028\u2029\ud800-\udfff]{1,128}$/,
  /** `ds_<token>` — the shape `store.newId()` mints. */
  dataset_id: /^ds_[A-Za-z0-9_]{1,64}$/,
  /** A domain id (hyphens allowed; `domainSchema()` maps it to the Trino schema). */
  domain: /^[a-z0-9][a-z0-9_-]{0,62}$/,
  /** A user id / service principal (usernames, e-mail-shaped uids). */
  principal: /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/,
  /** A connection id. */
  connection_id: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
  /** A frozen physical slug (`store-fqn.slug()` output). */
  slug: /^[a-z0-9_]{1,128}$/,
};

const KIND_HINT: Record<IdentifierKind, string> = {
  sql: 'letters, digits and underscores, not starting with a digit, at most 128 characters',
  column: 'at most 128 characters with no brace, double quote, backslash or control character',
  dataset_id: "'ds_' followed by letters, digits or underscores",
  domain: 'lowercase letters, digits, underscores and hyphens',
  principal: 'letters, digits and . _ @ -',
  connection_id: 'letters, digits and . _ -',
  slug: 'lowercase letters, digits and underscores',
};

export function isIdentifier(kind: IdentifierKind, value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERNS[kind].test(value);
}

/** Throw a typed `LiteralSafetyError` unless `value` matches the `kind` allow-list. */
export function assertIdentifier(kind: IdentifierKind, field: string, value: unknown): string {
  if (isIdentifier(kind, value)) return value;
  const shown = JSON.stringify(String(value ?? '').slice(0, 60));
  throw new LiteralSafetyError('invalid_identifier', field, String(value ?? ''), `${field} ${shown} is not allowed: use ${KIND_HINT[kind]}`);
}

// ------------------------------------------------------------------------------- cron ---

export function assertCron(field: string, cron: unknown): string {
  if (isValidCron(typeof cron === 'string' ? cron : undefined)) return cron as string;
  throw new LiteralSafetyError(
    'invalid_cron',
    field,
    String(cron ?? ''),
    `${field} ${JSON.stringify(String(cron ?? '').slice(0, 60))} is not a 5-field cron expression (e.g. "0 6 * * *")`,
  );
}

// -------------------------------------------------------------------------- free text ---

const FULLWIDTH_OPEN = '\uFF5B';
const FULLWIDTH_CLOSE = '\uFF5D';

/** U+2060 WORD JOINER — invisible; marks a fullwidth brace the AUTHOR typed (see below). */
const MARK = '\u2060';

/**
 * Free text for ANY file dbt renders (YAML description / label / meta value, SQL comment): the
 * ASCII braces become fullwidth braces, so no Jinja delimiter can ever form.
 *
 * EXACTLY reversible ({@link decodeFreeText}), so a git push → read-back keeps the author's
 * characters. Three token rules, applied left to right:
 *   `{` → U+FF5B  ·  `}` → U+FF5D            (the common case: output reads as before)
 *   U+FF5B → U+FF5B U+2060 · U+FF5D → U+FF5D U+2060   (a fullwidth brace the author typed)
 *   U+2060 → U+2060 U+2060                    (the marker itself, when the author typed it)
 * After a fullwidth brace, a run of k markers decodes uniquely: k odd ⇒ the author's fullwidth
 * brace plus (k−1)/2 markers; k even ⇒ an ASCII brace plus k/2 markers. Elsewhere a run is even.
 */
export function freeText(text: unknown): string {
  let out = '';
  for (const ch of wellFormed(String(text ?? ''))) {
    if (ch === '{') out += FULLWIDTH_OPEN;
    else if (ch === '}') out += FULLWIDTH_CLOSE;
    else if (ch === FULLWIDTH_OPEN || ch === FULLWIDTH_CLOSE) out += ch + MARK;
    else if (ch === MARK) out += MARK + MARK;
    else out += ch;
  }
  return out;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Well-formed Unicode: every lone surrogate becomes U+FFFD. A lone surrogate is legal in a JS (and
 * JSON) string but not in YAML text, and dbt's YAML loader refuses the whole file — one name would
 * then fail `dbt parse` for the entire domain. The store normalises at write time; free text and
 * the generator's checks normalise / refuse again.
 */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}

export function isWellFormed(text: string): boolean {
  LONE_SURROGATE.lastIndex = 0;
  const bad = LONE_SURROGATE.test(text);
  LONE_SURROGATE.lastIndex = 0;
  return !bad;
}

export function decodeFreeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    let k = 0;
    while (text[i + 1 + k] === MARK) k++;
    if (ch === FULLWIDTH_OPEN || ch === FULLWIDTH_CLOSE) {
      out += k % 2 === 1 ? ch : ch === FULLWIDTH_OPEN ? '{' : '}';
      out += MARK.repeat(Math.floor(k / 2));
      i += 1 + k;
    } else if (ch === MARK) {
      let run = 1;
      while (text[i + run] === MARK) run++;
      out += MARK.repeat(Math.ceil(run / 2));
      i += run;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Free text inside a `--` SQL comment: {@link freeText}, plus every line terminator a SQL engine or
 * editor may honour (CR, LF, NEL, U+2028, U+2029) becomes a space so the comment never ends early.
 */
export function commentText(text: unknown): string {
  return freeText(text).replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, ' ');
}

// --------------------------------------------------------------- compiled SQL bodies ---

/**
 * Make a compiled SQL body (the OS compilers' output) Jinja-free. A string literal that holds a
 * brace — a filter value such as `'{x}'` — is rewritten to the equivalent Trino Unicode literal
 * `U&'\007Bx\007D'`, which denotes exactly the same string (Trino "Unicode string literals"), so
 * the data meaning is unchanged and no Jinja delimiter remains. A brace OUTSIDE a string literal
 * cannot come from the OS compilers (identifiers are validated, comments are refused), so it is
 * refused rather than guessed at.
 */
export function jinjaFreeSql(body: string, field: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= body.length) {
          throw new LiteralSafetyError('invalid_identifier', field, body.slice(i, i + 60), `${field}: unterminated string literal`);
        }
        if (body[j] === "'") {
          if (body[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += body[j];
        j += 1;
      }
      const prefixedU = /U&$/i.test(out);
      if (/[{}]/.test(value)) {
        if (prefixedU) {
          throw new LiteralSafetyError('invalid_identifier', field, value.slice(0, 60), `${field}: a Unicode literal may not contain a brace`);
        }
        const esc = value.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\{/g, '\\007B').replace(/\}/g, '\\007D');
        out += `U&'${esc}'`;
      } else {
        out += body.slice(i, j + 1);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '}') {
      throw new LiteralSafetyError('invalid_identifier', field, body.slice(Math.max(0, i - 20), i + 20), `${field}: a brace outside a string literal is not allowed in generated SQL`);
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ----------------------------------------------------------- Trino identifier quoting ---

/**
 * Trino's reserved keywords at the chart's Trino 476 (https://trino.io/docs/476/language/reserved.html). A column named like one of these is
 * a valid identifier only when QUOTED, so the generator sets dbt's documented column property
 * `quote: true` on it — dbt then quotes it, with the adapter's quoting, in the tests it renders.
 */
export const TRINO_RESERVED = new Set([
  'alter', 'and', 'as', 'auto', 'between', 'by', 'case', 'cast', 'constraint', 'create', 'cross', 'cube',
  'current_catalog', 'current_date', 'current_path', 'current_role', 'current_schema', 'current_time',
  'current_timestamp', 'current_user', 'deallocate', 'delete', 'describe', 'distinct', 'drop', 'else', 'end',
  'escape', 'except', 'exists', 'extract', 'false', 'for', 'from', 'full', 'group', 'grouping', 'having',
  'in', 'inner', 'insert', 'intersect', 'into', 'is', 'join', 'json_array', 'json_exists', 'json_object',
  'json_query', 'json_table', 'json_value', 'left', 'like', 'listagg', 'localtime', 'localtimestamp',
  'natural', 'normalize', 'not', 'null', 'on', 'or', 'order', 'outer', 'prepare', 'recursive', 'right',
  'rollup', 'select', 'skip', 'table', 'then', 'trim', 'true', 'uescape', 'union', 'unnest', 'using',
  'values', 'when', 'where', 'with',
]);

/** A column dbt must quote: a Trino reserved word, or a physical name that is no plain identifier. */
export function needsQuote(column: string): boolean {
  return TRINO_RESERVED.has(column.toLowerCase()) || !IDENTIFIER_PATTERNS.sql.test(column);
}

// ------------------------------------------------------------- column name mapping ---

const TRANSLIT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue', ẞ: 'ss', æ: 'ae', Æ: 'ae', ø: 'oe', Ø: 'oe', å: 'aa', Å: 'aa', œ: 'oe', Œ: 'oe', þ: 'th', ð: 'd', ł: 'l', Ł: 'l', '€': 'eur', '%': 'pct', '#': 'nr', '&': 'and' };

/**
 * The documented normalisation from a source column header to a Trino identifier:
 *   1. transliterate German / Nordic letters (ä→ae, ö→oe, ü→ue, ß→ss, …) and `€ % # &`;
 *   2. Unicode NFKD, combining marks dropped (é→e);
 *   3. lowercase; every run of characters outside `[a-z0-9]` becomes one `_`; `_` trimmed;
 *   4. a leading digit gets the prefix `c_`; an empty result is `column`; at most 120 characters.
 * `Order Date` → `order_date`, `größe` → `groesse`, `kunden-nr` → `kunden_nr`, `Umsatz (€)` →
 * `umsatz_eur`, `2024` → `c_2024`. Collisions are resolved by {@link allocateColumnNames}.
 */
export function normalizeColumnName(raw: string): string {
  const t = [...wellFormed(String(raw ?? ''))].map((ch) => TRANSLIT[ch] ?? ch).join('');
  const core = t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
    .replace(/_+$/, '');
  if (!core) return 'column';
  return /^[0-9]/.test(core) ? `c_${core}` : core;
}

/**
 * Map every header of an upload to a STABLE, unique identifier. A header the dataset already
 * knows (its stored `source`, or a stored name equal to the header) keeps its stored name —
 * the mapping is recorded once and never re-derived. A new header is normalised; a collision
 * with a stored or an earlier name gets `_2`, `_3`, … in header order. Deterministic.
 */
export function allocateColumnNames(
  headers: string[],
  existing: { name: string; source?: string }[] = [],
): { source: string; name: string }[] {
  const known = new Map<string, string>();
  for (const c of existing) {
    known.set(c.source ?? c.name, c.name);
    if (!known.has(c.name)) known.set(c.name, c.name);
  }
  const taken = new Set(existing.map((c) => c.name.toLowerCase()));
  const out: { source: string; name: string }[] = [];
  for (const h of headers) {
    const stored = known.get(h);
    if (stored !== undefined) {
      out.push({ source: h, name: stored });
      taken.add(stored.toLowerCase());
      continue;
    }
    const base = normalizeColumnName(h);
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 120 - String(i).length - 1)}_${i}`;
    taken.add(name.toLowerCase());
    known.set(h, name);
    out.push({ source: h, name });
  }
  return out;
}

// ------------------------------------------------------------------ dataset validation ---

export type LiteralIssue = { field: string; value: string; reason: string };

/**
 * Every identifier and cron a dataset contributes to its domain's dbt project, checked against the
 * allow-lists. An empty list means the dataset may be rendered.
 */
export function datasetLiteralIssues(d: Dataset): LiteralIssue[] {
  const issues: LiteralIssue[] = [];
  const check = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof LiteralSafetyError) issues.push({ field: e.field, value: e.value, reason: e.message });
      else throw e;
    }
  };
  check(() => assertIdentifier('dataset_id', 'dataset id', d.id));
  check(() => assertIdentifier('domain', 'domain', d.domain));
  check(() => assertIdentifier('principal', 'owner', d.owner));
  if (d.slug != null) check(() => assertIdentifier('slug', 'slug', d.slug));
  (d.columns ?? []).forEach((c, i) => check(() => assertIdentifier('column', `columns[${i}].name`, c.name)));
  (d.checks ?? []).forEach((c, i) => {
    if (!c.rule) return; // a free-text intention: its name is free text, no identifier
    if (c.column !== undefined) check(() => assertIdentifier('sql', `checks[${i}].column`, c.column));
    if (c.toColumn !== undefined) check(() => assertIdentifier('sql', `checks[${i}].toColumn`, c.toColumn));
    if (c.toDataset !== undefined) check(() => assertIdentifier('dataset_id', `checks[${i}].toDataset`, c.toDataset));
  });
  (d.upstreams ?? []).forEach((u, i) => check(() => assertIdentifier('dataset_id', `upstreams[${i}].datasetId`, u.datasetId)));
  if (d.sync) {
    const s = d.sync;
    check(() => assertIdentifier('connection_id', 'sync.connectionId', s.connectionId));
    check(() => assertIdentifier('sql', 'sync.source.schema', s.source?.schema));
    check(() => assertIdentifier('sql', 'sync.source.table', s.source?.table));
    check(() => assertCron('sync.schedule.cron', s.schedule?.cron));
    if (s.cursor) check(() => assertIdentifier('sql', 'sync.cursor.column', s.cursor!.column));
    (s.mergeKeys ?? []).forEach((k, i) => check(() => assertIdentifier('sql', `sync.mergeKeys[${i}]`, k)));
  }
  if (d.connected && d.connected.mode === 'sync') {
    const src = d.connected.source;
    check(() => assertIdentifier('sql', 'connected.source.catalog', src.catalog));
    check(() => assertIdentifier('sql', 'connected.source.schema', src.schema));
    check(() => assertIdentifier('sql', 'connected.source.table', src.table));
  }
  return issues;
}
