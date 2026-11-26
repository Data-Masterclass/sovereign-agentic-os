/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    TEST-TOP-LEVEL-AWAIT — find a top-level `await` that comes after a test file has
 *             started registering tests or root hooks
 * USER STORY: As a maintainer I want CI to refuse a test file that registers a test()/describe()/
 *             root hook and only THEN awaits at top level: on Node 22 the runner starts the tests
 *             already registered while the module is still suspended on that await, and may run
 *             root hooks (an after() that restores a stubbed fetch) before the later tests exist.
 *             That is how chat-attachment-sinks.test.ts went green on Node 24 and red in CI (#365).
 * ARCHITECTURE:
 *   - Pure function over the TypeScript AST (the compiler os-ui already depends on, passed in):
 *     walk the SourceFile's top-level statements; the first one that is a call to test / it /
 *     describe / suite / before / after / beforeEach / afterEach (bare, or `test.only(…)` /
 *     `describe.skip(…)` style) opens the window; every later top-level
 *     statement holding an `await` (or `for await`) that is not inside a function is reported.
 *   - Used by scripts/check-structure.mjs (rule 8); proven by scripts/tests/check-test-top-level-await.test.mjs.
 */

const REGISTRARS = new Set(['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach']);

/** The registrar name a top-level call statement uses, or null (`test(…)`, `test.only(…)`, `describe.skip(…)`). */
function registrarOf(ts, stmt) {
  if (!ts.isExpressionStatement(stmt)) return null;
  let e = stmt.expression;
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isVoidExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return null;
  let callee = e.expression;
  if (ts.isIdentifier(callee)) return REGISTRARS.has(callee.text) ? callee.text : null;
  // `test.only(…)` / `describe.skip(…)` → the object is the registrar
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && REGISTRARS.has(callee.expression.text)) return callee.expression.text;
  return null;
}

/** The first `await` (or `for await`) in `node` that is not inside a nested function, or null. */
function topLevelAwaitIn(ts, node) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return; // its awaits run later, not at module evaluation
    if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) { found = n; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * @param ts         the `typescript` module
 * @param fileName   used for the script kind (.ts / .mjs) and nothing else
 * @param text       the file's source
 * @returns          [{ line, registrar, registrarLine }] — 1-based lines, one entry per offending statement
 */
export function lateTopLevelAwaits(ts, fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.m?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];
  let first = null;
  for (const stmt of sf.statements) {
    if (!first) {
      const name = registrarOf(ts, stmt);
      if (name) first = { registrar: name, registrarLine: lineOf(stmt.getStart(sf)) };
      continue;
    }
    const a = topLevelAwaitIn(ts, stmt);
    if (a) out.push({ line: lineOf(a.getStart(sf)), ...first });
  }
  return out;
}
