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

export type IdentifierKind = 'sql' | 'dataset_id' | 'domain' | 'principal' | 'connection_id' | 'slug';

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

/**
 * Free text for ANY file dbt renders (YAML description / label / meta value, SQL comment): the
 * ASCII braces become fullwidth braces, so no Jinja delimiter can ever form. Reversible with
 * {@link decodeFreeText} for every text that held no fullwidth brace of its own (the OS store
 * keeps the original either way; this is only the dbt projection).
 */
export function freeText(text: unknown): string {
  return String(text ?? '').replace(/\{/g, FULLWIDTH_OPEN).replace(/\}/g, FULLWIDTH_CLOSE);
}

export function decodeFreeText(text: string): string {
  return text.replace(/\uFF5B/g, '{').replace(/\uFF5D/g, '}');
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

export function needsQuote(column: string): boolean {
  return TRINO_RESERVED.has(column.toLowerCase());
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
  (d.columns ?? []).forEach((c, i) => check(() => assertIdentifier('sql', `columns[${i}].name`, c.name)));
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
