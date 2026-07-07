/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Talk-to-your-data v2 — the PURE NL→SQL core behind /api/data/ask (T9).
 *
 * Flow (all dependencies injected, so every invariant is unit-testable):
 *   1. The prompt context is built ONLY from the registry docs the route passes in —
 *      `listAskable(user)` is canView-scoped, so another user's schema/docs can never
 *      leak into the prompt. This module never touches the store itself.
 *   2. The model generates ONE read-only SELECT, which {@link validateReadOnlySelect}
 *      lints with the SAME discipline as `transform.ts` (single statement, no
 *      comments, no ';') plus a SELECT-only keyword gate. Anything else is REJECTED —
 *      it never reaches execution.
 *   3. Execution happens via the injected `query` — the route wires the governed
 *      `queryRun(sql, principal)`, so Trino→OPA row filters + column masks apply to
 *      the answer automatically. There is no other execution door.
 *   4. The answer is written grounded ONLY in the returned rows (the summary prompt
 *      contains nothing else). 0 rows / no accessible dataset are answered honestly —
 *      never fabricated.
 *
 * Kept free of `server-only` / Next / network imports (mirrors transform.ts/profile.ts).
 */
import { isNotMaterialized, notMaterializedReason } from './materialized.ts';

export type AskColumn = { name: string; description: string };

/** One dataset the caller may see — the ONLY schema the model is shown. */
export type AskDataset = {
  id: string;
  name: string;
  domain: string;
  tier: string;
  /** Physical Trino FQN of the furthest built layer. */
  fqn: string;
  description: string;
  columns: AskColumn[];
};

/** The exact token the model must return when nothing it can see answers. */
export const NO_DATASET_TOKEN = 'NO_ACCESSIBLE_DATASET';

export const NO_DATASET_MESSAGE =
  'No accessible dataset matches this question — nothing you can view holds that data.';

// ------------------------------------------------------------ SQL extraction --

/** Pull the SQL out of a model reply: unwrap one markdown fence if present and
 *  tolerate exactly one trailing ';' (models love both). */
export function extractSql(text: string): string {
  const t = (text ?? '').trim();
  const fence = t.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  let sql = (fence ? fence[1] : t).trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
  return sql;
}

// ------------------------------------------------------------ SQL validation --

/** Blank out string literals + quoted identifiers so keyword/comment scanning can't
 *  be fooled by (or false-positive on) quoted content. */
function stripQuoted(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/** Statement kinds that write, mutate or escape a single read — never executed. */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|call|prepare|execute|deallocate|set|reset|use|comment|deny|analyze|refresh)\b/i;

const MAX_SQL_LENGTH = 8000;

export type SqlValidation = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * The read-only gate: exactly ONE SELECT (WITH…SELECT allowed), no comments, no
 * statement separator, no write/DDL/session keyword anywhere outside quotes. Mirrors
 * the transform.ts lint discipline (`assertNoSqlMeta`) — reject at validation time
 * with a clear reason instead of ever executing a doubtful statement.
 */
export function validateReadOnlySelect(raw: string): SqlValidation {
  const sql = (raw ?? '').trim();
  if (!sql) return { ok: false, reason: 'the model returned no SQL' };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, reason: 'generated SQL is implausibly long' };
  const bare = stripQuoted(sql);
  if (bare.includes('--') || bare.includes('/*') || bare.includes('*/') || bare.includes('#')) {
    return { ok: false, reason: 'SQL comments are not allowed' };
  }
  if (bare.includes(';')) return { ok: false, reason: 'exactly one statement is allowed' };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, reason: 'only a read-only SELECT is allowed' };
  const hit = bare.match(WRITE_KEYWORDS);
  if (hit) return { ok: false, reason: `read-only: '${hit[1].toLowerCase()}' is not allowed` };
  // Reject a raw HYPHENATED identifier reaching Trino — e.g. the model copying the
  // cohort domain / dataset display name as `agentic-leader-Q3-2026`, which Trino
  // parses as subtraction and rejects (`SYNTAX_ERROR: mismatched input 'Q3'`). Every
  // valid physical name is a slugified FQN (underscores, no hyphen); real subtraction
  // is spaced. So an unquoted `word-word` run is an invalid table identifier — reject
  // it here with a clear reason instead of shipping a doomed statement.
  const hyphen = bare.match(/[A-Za-z_][A-Za-z0-9_]*-[A-Za-z0-9_]/);
  if (hyphen) {
    return {
      ok: false,
      reason: `invalid identifier '${hyphen[0]}…' — reference tables only by their exact fully-qualified name`,
    };
  }
  return { ok: true, sql };
}

// ----------------------------------------------------------------- prompting --

/** Render the caller-visible registry docs as the model's ONLY schema knowledge. */
export function schemaContext(datasets: AskDataset[]): string {
  return datasets
    .map((d) => {
      const cols =
        d.columns.length > 0
          ? d.columns.map((c) => (c.description ? `${c.name} (${c.description})` : c.name)).join(', ')
          : '(columns not documented — use only columns you are certain exist)';
      const lines = [`Table: ${d.fqn}  — dataset "${d.name}" (domain ${d.domain}, tier ${d.tier})`];
      if (d.description.trim()) lines.push(`  Description: ${d.description.trim()}`);
      lines.push(`  Columns: ${cols}`);
      return lines.join('\n');
    })
    .join('\n');
}

export type AskMessage = { role: 'system' | 'user'; content: string };

export function sqlGenMessages(question: string, datasets: AskDataset[]): AskMessage[] {
  const system = [
    "You translate a user's question into ONE Trino SQL SELECT over a governed lakehouse.",
    '',
    "These are ALL the datasets the caller may access — for you, nothing else exists:",
    schemaContext(datasets),
    '',
    'Rules:',
    '- Output ONLY the SQL statement: no prose, no markdown fence, no comments, no semicolon.',
    '- Exactly one read-only SELECT (WITH … SELECT is fine). Never INSERT/UPDATE/DELETE/CREATE/DROP.',
    '- Reference tables ONLY by the exact fully-qualified name after "Table:" — use it verbatim.',
    "- NEVER build a table name from a dataset's display name or domain label: those are",
    '  context only and are NOT valid identifiers (they may contain spaces/hyphens/capitals).',
    '  The FQNs are already lowercase, underscore-separated, and hyphen-free — do not alter them.',
    '- Lowercase identifiers; standard Trino SQL functions only.',
    '- End non-aggregating queries with "limit 100".',
    `- If NONE of the listed datasets can answer the question, reply with exactly ${NO_DATASET_TOKEN}.`,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];
}

/** How much of the result the summary model sees (grounding cap, not a data cap). */
const MAX_SUMMARY_ROWS = 50;
const MAX_CELL_CHARS = 200;

export type AskGrid = { columns: string[]; rows: string[][]; rowCount: number };

export function answerMessages(question: string, sql: string, grid: AskGrid): AskMessage[] {
  const shown = grid.rows.slice(0, MAX_SUMMARY_ROWS);
  const tsv = [
    grid.columns.join('\t'),
    ...shown.map((r) => r.map((c) => String(c ?? '').slice(0, MAX_CELL_CHARS)).join('\t')),
  ].join('\n');
  const system = [
    "Write a short, plain-language answer to the user's question, grounded ONLY in the SQL result below.",
    'Every number and name you state MUST appear in the rows — no outside knowledge, no invented values.',
    'Two or three sentences at most. If the rows only partially answer the question, say so.',
  ].join('\n');
  const user = [
    `Question: ${question}`,
    '',
    'SQL executed:',
    sql,
    '',
    `Result (${grid.rowCount} row${grid.rowCount === 1 ? '' : 's'} total, first ${shown.length} shown):`,
    tsv,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// --------------------------------------------------------------- orchestrator --

export type AskLlm = (messages: AskMessage[], model: string) => Promise<string>;
export type AskModels = { generate: string; summarize: string };

export type AskSuccess = {
  ok: true;
  sql: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  answer: string;
};
export type AskFailure = {
  ok: false;
  kind: 'no_dataset' | 'invalid_sql' | 'query_failed' | 'not_materialized';
  message: string;
  sql?: string;
};
export type AskOutcome = AskSuccess | AskFailure;

/**
 * One NL→SQL turn: context → generate → validate → governed query → grounded answer.
 * Every failure is an HONEST state with a reason; invalid SQL is never executed.
 */
export async function runAsk(input: {
  question: string;
  datasets: AskDataset[];
  llm: AskLlm;
  models: AskModels;
  /** The governed read path — the route wires `queryRun(sql, principal)`. */
  query: (sql: string) => Promise<AskGrid>;
}): Promise<AskOutcome> {
  const question = input.question.trim();
  if (input.datasets.length === 0) {
    return { ok: false, kind: 'no_dataset', message: NO_DATASET_MESSAGE };
  }

  const raw = await input.llm(sqlGenMessages(question, input.datasets), input.models.generate);
  const sql = extractSql(raw);
  if (sql.toUpperCase().includes(NO_DATASET_TOKEN)) {
    return { ok: false, kind: 'no_dataset', message: NO_DATASET_MESSAGE };
  }

  const v = validateReadOnlySelect(sql);
  if (!v.ok) return { ok: false, kind: 'invalid_sql', message: v.reason, sql };

  let grid: AskGrid;
  try {
    grid = await input.query(v.sql);
  } catch (e) {
    // A dataset can be REGISTERED (and even flagged built) while its physical Iceberg
    // table was never materialized — Trino answers TABLE_NOT_FOUND/"does not exist".
    // That is "not built yet", not a broken platform: answer it calmly instead of
    // bubbling a raw Trino stack trace to the student.
    if (isNotMaterialized(e)) {
      return {
        ok: false,
        kind: 'not_materialized',
        message: notMaterializedReason('A dataset this question needs'),
        sql: v.sql,
      };
    }
    return { ok: false, kind: 'query_failed', message: (e as Error).message, sql: v.sql };
  }

  if (grid.rowCount === 0 || grid.rows.length === 0) {
    return {
      ok: true,
      sql: v.sql,
      columns: grid.columns,
      rows: [],
      rowCount: 0,
      answer: 'The query ran but returned no rows — the datasets you can see hold no data matching this question.',
    };
  }

  let answer: string;
  try {
    answer = (await input.llm(answerMessages(question, v.sql, grid), input.models.summarize)).trim();
  } catch {
    // The rows are real and governed — show them even if the summary model is down.
    answer = 'The query succeeded (see the result table below), but the summary model was unreachable.';
  }
  return { ok: true, sql: v.sql, columns: grid.columns, rows: grid.rows, rowCount: grid.rowCount, answer };
}
