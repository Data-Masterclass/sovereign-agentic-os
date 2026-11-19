/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Which tables does a read-only SQL statement name?
 * USER STORY: As the owner of an agent system granted TWO datasets I want its `query_data` calls
 *             checked against those two tables before they run, so "the agent only reads what I
 *             granted" is a fact about the engine and not a hope about the model.
 * ARCHITECTURE:
 *   - A small tokenizer plus a clause tracker — NOT a SQL parser, and it does not pretend to be
 *     one. It answers one question soundly: either "these are ALL the relations this statement
 *     reads" or "I cannot tell" (with the reason). It never answers a partial list.
 *   - SOUND BY REFUSING. Anything it cannot follow is a refusal the caller turns into a typed,
 *     model-readable error: a statement that is not SELECT/WITH, a table function (`TABLE(...)`,
 *     any `name(` in a relation position other than UNNEST), a nested `WITH`, more than one
 *     statement, an unterminated string or quote.
 *   - A relation is recognised wherever one can appear: after FROM / JOIN, after a comma inside a
 *     FROM clause, and after the `TABLE <name>` shorthand. `FROM` inside EXTRACT / SUBSTRING /
 *     TRIM / OVERLAY and `IS [NOT] DISTINCT FROM` is an expression, not a relation.
 *   - A CTE name counts as local only AFTER its own body has closed, so `WITH a AS (SELECT * FROM
 *     b), b AS (...)` reports the outer table `b`, and a self-reference is reported too (a
 *     recursive CTE is therefore refused under a restriction — rare, and said plainly).
 *   - Pure: no I/O, no `server-only`.
 */

export type SqlTables =
  | { ok: true; /** Every relation read, lower-cased, parts joined by '.', deduped, in order. */ tables: string[] }
  | { ok: false; reason: string };

type Tok =
  | { t: 'id'; v: string; quoted: boolean }
  | { t: 'sym'; v: string }
  | { t: 'lit' };

/** Split into identifiers, symbols and opaque literals. Comments are dropped. */
function tokenize(sql: string): Tok[] | { error: string } {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return { error: 'an unterminated /* comment' };
      i = end + 2;
      continue;
    }
    if (c === "'") {
      // A string literal; '' is an escaped quote.
      let j = i + 1;
      for (;;) {
        if (j >= n) return { error: 'an unterminated string literal' };
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out.push({ t: 'lit' });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === '`') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= n) return { error: 'an unterminated quoted identifier' };
        if (sql[j] === c) {
          if (sql[j + 1] === c) { v += c; j += 2; continue; }
          break;
        }
        v += sql[j];
        j += 1;
      }
      out.push({ t: 'id', v: v.toLowerCase(), quoted: true });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
      out.push({ t: 'id', v: sql.slice(i, j).toLowerCase(), quoted: false });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j += 1;
      out.push({ t: 'lit' });
      i = j;
      continue;
    }
    out.push({ t: 'sym', v: c });
    i += 1;
  }
  return out;
}

/** Keywords that end a FROM clause at the depth it was opened. */
const FROM_ENDERS = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'union', 'intersect', 'except', 'window', 'select',
]);
/** Functions whose argument list uses the word FROM as syntax, not as a clause. */
const FROM_AS_SYNTAX = new Set(['extract', 'substring', 'trim', 'overlay']);
/** Words that can follow a relation and are never the start of another one. */
const JOIN_WORDS = new Set(['inner', 'left', 'right', 'full', 'outer', 'cross', 'natural']);

/**
 * Every relation a single read-only statement names — or the reason they cannot be listed.
 * See the file header for exactly what is recognised and what is refused.
 */
export function sqlTableRefs(sql: string): SqlTables {
  const toks = tokenize(String(sql ?? ''));
  if (!Array.isArray(toks)) return { ok: false, reason: `the SQL has ${toks.error}` };
  // One trailing `;` is tolerated (the query tool strips it); anything after one is a second statement.
  while (toks.length > 0 && toks[toks.length - 1].t === 'sym' && (toks[toks.length - 1] as { v: string }).v === ';') toks.pop();
  if (toks.some((t) => t.t === 'sym' && t.v === ';')) return { ok: false, reason: 'it holds more than one statement' };

  const isKw = (t: Tok | undefined, v: string): boolean => !!t && t.t === 'id' && !t.quoted && t.v === v;
  const isSym = (t: Tok | undefined, v: string): boolean => !!t && t.t === 'sym' && t.v === v;

  let start = 0;
  while (isSym(toks[start], '(')) start += 1;
  if (!isKw(toks[start], 'select') && !isKw(toks[start], 'with')) {
    return { ok: false, reason: 'it is not a SELECT (only SELECT / WITH … SELECT statements can be checked against a grant)' };
  }

  const tables: string[] = [];
  const seen = new Set<string>();
  const ctes = new Set<string>();
  /** A CTE whose body is open: it becomes local when the paren at `depth` closes. */
  const openCtes: { name: string; depth: number }[] = [];
  /** One frame per open paren (index 0 = the statement itself). */
  type Frame = { inFrom: boolean; fromIsSyntax: boolean };
  const frames: Frame[] = [{ inFrom: false, fromIsSyntax: false }];
  /** The next `(` opens a parenthesised RELATION (`FROM (a JOIN b …)`, `FROM (t)`) or a subquery. */
  let relationParen = false;
  const SUBQUERY_START = new Set(['select', 'with', 'values', 'table']);
  const top = (): Frame => frames[frames.length - 1];
  let withSeen = false;

  /** Read a relation starting at `i`; returns the index after it, or an error. */
  const readRelation = (i: number): number | { error: string } => {
    const t = toks[i];
    if (!t) return { error: 'a FROM / JOIN with nothing after it' };
    // A subquery or a parenthesised relation: the main loop walks into it, knowing which it may be.
    if (isSym(t, '(')) { relationParen = true; return i; }
    if (isKw(t, 'lateral')) return i + 1; // LATERAL ( … ) — the subquery is walked by the main loop
    if (t.t !== 'id') return { error: 'something other than a table name after FROM / JOIN' };
    // `name (` in a relation position is a table function; UNNEST reads no table.
    if (!t.quoted && isSym(toks[i + 1], '(')) {
      if (t.v === 'unnest') return i + 1;
      return { error: `the table function ${t.v}(…), which can read tables this check cannot see` };
    }
    const parts = [t.v];
    let j = i + 1;
    while (isSym(toks[j], '.') && toks[j + 1]?.t === 'id') {
      parts.push((toks[j + 1] as { v: string }).v);
      j += 2;
    }
    if (isSym(toks[j], '(')) return { error: `the table function ${parts.join('.')}(…), which can read tables this check cannot see` };
    const name = parts.join('.');
    if (!(parts.length === 1 && ctes.has(name)) && !seen.has(name)) {
      seen.add(name);
      tables.push(name);
    }
    return j;
  };

  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.t === 'sym') {
      if (t.v === '(') {
        const prev = toks[i - 1];
        const fromIsSyntax = !!prev && prev.t === 'id' && !prev.quoted && FROM_AS_SYNTAX.has(prev.v);
        const opensRelation = relationParen;
        relationParen = false;
        frames.push({ inFrom: false, fromIsSyntax });
        if (opensRelation) {
          // `FROM (` — a subquery starts with SELECT / WITH / VALUES / TABLE; anything else is a
          // relation in parentheses (`FROM (a.b.c)`, `FROM (a JOIN b ON …)`), read here.
          const next = toks[i + 1];
          const subquery = !!next && next.t === 'id' && !next.quoted && SUBQUERY_START.has(next.v);
          if (!subquery) {
            top().inFrom = true;
            const r = readRelation(i + 1);
            if (typeof r !== 'number') return { ok: false, reason: `it uses ${r.error}` };
            i = r;
            continue;
          }
        }
      } else if (t.v === ')') {
        if (frames.length === 1) return { ok: false, reason: 'its parentheses do not balance' };
        frames.pop();
        const open = openCtes[openCtes.length - 1];
        if (open && open.depth === frames.length) {
          ctes.add(open.name);
          openCtes.pop();
        }
      } else if (t.v === ',' && top().inFrom) {
        const r = readRelation(i + 1);
        if (typeof r !== 'number') return { ok: false, reason: `it uses ${r.error}` };
        i = r;
        continue;
      }
      i += 1;
      continue;
    }
    if (t.t !== 'id' || t.quoted) { i += 1; continue; }

    if (t.v === 'with') {
      // `WITH` also appears as `WITH ORDINALITY` / `WITH TIES` / `WITH (prop = …)`: only a WITH
      // followed by `name AS (` or RECURSIVE opens CTEs.
      const opensCte = isKw(toks[i + 1], 'recursive') || (toks[i + 1]?.t === 'id' && isKw(toks[i + 2], 'as') && isSym(toks[i + 3], '('));
      if (opensCte) {
        if (frames.length > 1 || withSeen) return { ok: false, reason: 'it uses a nested WITH, which this check cannot follow — put every WITH at the start of the statement' };
        withSeen = true;
      }
      i += 1;
      continue;
    }
    // `<name> AS (` at the top level, straight after WITH or after a CTE body's comma: a CTE definition.
    if (withSeen && frames.length === 1 && isKw(toks[i + 1], 'as') && isSym(toks[i + 2], '(') && (isKw(toks[i - 1], 'with') || isKw(toks[i - 1], 'recursive') || isSym(toks[i - 1], ','))) {
      openCtes.push({ name: t.v, depth: 1 });
      i += 2; // leave the `(` to the main loop so its frame is pushed
      continue;
    }
    if (t.v === 'from') {
      const distinctFrom = isKw(toks[i - 1], 'distinct') && (isKw(toks[i - 2], 'is') || isKw(toks[i - 2], 'not'));
      if (top().fromIsSyntax || distinctFrom) { i += 1; continue; }
      top().inFrom = true;
      const r = readRelation(i + 1);
      if (typeof r !== 'number') return { ok: false, reason: `it uses ${r.error}` };
      i = r;
      continue;
    }
    if (t.v === 'join') {
      const r = readRelation(i + 1);
      if (typeof r !== 'number') return { ok: false, reason: `it uses ${r.error}` };
      i = r;
      continue;
    }
    if (t.v === 'table') {
      // `TABLE name` is shorthand for `SELECT * FROM name`; `TABLE(…)` is a table function.
      if (isSym(toks[i + 1], '(')) return { ok: false, reason: 'it uses a TABLE(…) function, which can read tables this check cannot see' };
      if (toks[i + 1]?.t === 'id') {
        const r = readRelation(i + 1);
        if (typeof r !== 'number') return { ok: false, reason: `it uses ${r.error}` };
        i = r;
        continue;
      }
    }
    if (FROM_ENDERS.has(t.v)) top().inFrom = false;
    else if (JOIN_WORDS.has(t.v)) { /* part of a join keyword — the relation follows JOIN */ }
    i += 1;
  }
  if (frames.length !== 1) return { ok: false, reason: 'its parentheses do not balance' };
  return { ok: true, tables };
}
