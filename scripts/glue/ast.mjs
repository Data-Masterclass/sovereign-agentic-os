/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The TypeScript-AST layer of the glue-discipline checker (scripts/check-glue.mjs).
 * USER STORY: As the owner I want a rule to see through the cheap rewrites that defeat a grep —
 *             an aliased `fetch`, a version built with `join`, `export { handler as POST }`, a
 *             module name assembled from parts — so imitation code cannot slip past by spelling.
 * ARCHITECTURE:
 *   - Parses with the TypeScript compiler API (`ts.createSourceFile`, Apache-2.0, the repo's own
 *     pinned `typescript`). No type checker: a syntax tree per file plus a per-file table of
 *     `const` initialisers and import bindings is enough for every rule.
 *   - `fold(node)` is a small constant folder: string/number literals, templates, `+`, parens,
 *     `as`/`satisfies`, `[…].join(sep)` and identifiers bound to a `const` in the same file.
 *     A rule checks the folded value, so `'v1.2' + '.3'` is `'v1.2.3'`.
 *   - `imports` lists every module reference — static, `export … from`, `import()` and
 *     `require()` — with the folded specifier, or `null` when it cannot be folded (a rule then
 *     reports "cannot verify").
 *   - Pure: no I/O besides what the caller passes in.
 */
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'os-ui');
export const ts = createRequire(join(TOOLS, 'package.json'))('typescript');
const K = ts.SyntaxKind;

const kindFor = (p) => (p.endsWith('.tsx') ? ts.ScriptKind.TSX : p.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

export function parse(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kindFor(rel));
  const consts = new Map(); // name -> initializer (first const wins)
  const bindings = new Map(); // local name -> { module, name }  ('default' | '*' | imported name)
  const imports = []; // { spec: string|null, kind, node }
  const fns = new Map(); // function declaration name -> node
  const requirers = new Set(); // local names bound to createRequire(...)(…)-style require functions
  const isCreateRequire = (e) => ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'createRequire';
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && !fns.has(n.name.text)) fns.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isCreateRequire(unwrap(n.initializer))) requirers.add(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (n.parent.flags & ts.NodeFlags.Const) && !consts.has(n.name.text)) consts.set(n.name.text, n.initializer);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const module = n.moduleSpecifier.text;
      imports.push({ spec: module, kind: n.importClause?.isTypeOnly ? 'type' : 'static', node: n });
      const c = n.importClause;
      if (c?.name) bindings.set(c.name.text, { module, name: 'default' });
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) bindings.set(c.namedBindings.name.text, { module, name: '*' });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) bindings.set(e.name.text, { module, name: (e.propertyName ?? e.name).text });
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) imports.push({ spec: n.moduleSpecifier.text, kind: 'static', node: n });
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === K.ImportKeyword) imports.push({ spec: null, kind: 'dynamic', node: n, arg: n.arguments[0] });
      else if (ts.isIdentifier(n.expression) && (n.expression.text === 'require' || requirers.has(n.expression.text)) && n.arguments.length === 1) imports.push({ spec: null, kind: 'require', node: n, arg: n.arguments[0] });
      else if (isCreateRequire(unwrap(n.expression)) && n.arguments.length === 1) imports.push({ spec: null, kind: 'require', node: n, arg: n.arguments[0] });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const file = { rel, text, sf, consts, bindings, imports, fns };
  for (const i of imports) if (i.arg) i.spec = fold(file, i.arg) ?? null;
  return file;
}

const unwrap = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression?.(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression;
  return n;
};
export { unwrap };

/** Constant-fold `node` to a string, or undefined. */
export function fold(file, node, depth = 0) {
  node = unwrap(node);
  if (!node || depth > 8) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) { const v = fold(file, span.expression, depth + 1); if (v === undefined) return undefined; s += v + span.literal.text; }
    return s;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === K.PlusToken) {
    const a = fold(file, node.left, depth + 1); if (a === undefined) return undefined;
    const b = fold(file, node.right, depth + 1); return b === undefined ? undefined : a + b;
  }
  if (ts.isIdentifier(node)) { const init = file.consts.get(node.text); return init && init !== node ? fold(file, init, depth + 1) : undefined; }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
    const arr = unwrap(node.expression.expression);
    const list = ts.isArrayLiteralExpression(arr) ? arr : ts.isIdentifier(arr) ? unwrap(file.consts.get(arr.text)) : undefined;
    if (!list || !ts.isArrayLiteralExpression(list)) return undefined;
    const sep = node.arguments.length ? fold(file, node.arguments[0], depth + 1) : ',';
    if (sep === undefined) return undefined;
    const parts = list.elements.map((e) => fold(file, e, depth + 1));
    return parts.some((p) => p === undefined) ? undefined : parts.join(sep);
  }
  return undefined;
}

/** True when `node` sits in a type position (a type annotation, `typeof x` in a type, …). */
export function inType(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isStatement(p) || ts.isExpressionStatement(p)) return false;
  }
  return false;
}

/** True when an Identifier is a reference to a free (global) name, not a declaration, key or member. */
export function isFreeRef(id) {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isBindingElement(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isQualifiedName(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isJsxAttribute?.(p)) return false;
  return !inType(id);
}

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
/** Every reference to the global `name` (bare, `globalThis.name`, `globalThis['name']`) in the file. */
export function globalRefs(file, name) {
  const out = [];
  const globals = new Set(GLOBAL_OBJECTS);
  for (const [k, init] of file.consts) { const u = unwrap(init); if (ts.isIdentifier(u) && GLOBAL_OBJECTS.has(u.text)) globals.add(k); }
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === name && isFreeRef(n)) out.push(n);
    else if (ts.isPropertyAccessExpression(n) && n.name.text === name && ts.isIdentifier(unwrap(n.expression)) && globals.has(unwrap(n.expression).text)) { out.push(n); return; }
    else if (ts.isElementAccessExpression(n) && ts.isIdentifier(unwrap(n.expression)) && globals.has(unwrap(n.expression).text) && fold(file, n.argumentExpression) === name) { out.push(n); return; }
    ts.forEachChild(n, visit);
  };
  visit(file.sf);
  return out;
}

export const lineOf = (file, node) => file.sf.getLineAndCharacterOfPosition(node.getStart(file.sf)).line + 1;
export const snippet = (file, node, max = 90) => node.getText(file.sf).replace(/\s+/g, ' ').trim().slice(0, max);

export function walk(file, fn) {
  const visit = (n) => { if (fn(n) === false) return; ts.forEachChild(n, visit); };
  visit(file.sf);
}

/** Names this module exports (local declarations, `export { a as b }`, `export default`). */
export function exportedNames(file) {
  const out = [];
  for (const st of file.sf.statements) {
    const exp = ts.canHaveModifiers?.(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === K.ExportKeyword);
    if (exp && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.push({ name: st.name.text, local: st.name.text, node: st });
    if (exp && ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, local: d.name.text, node: d });
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) out.push({ name: e.name.text, local: (e.propertyName ?? e.name).text, node: e });
  }
  return out;
}

/** The declared name of a function-like thing: `function f`, `const f = () =>`, a method. */
export function functionName(n) {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) return n.name.text;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(unwrap(n.initializer)) || ts.isFunctionExpression(unwrap(n.initializer)))) return n.name.text;
  if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && (ts.isArrowFunction(unwrap(n.initializer)) || ts.isFunctionExpression(unwrap(n.initializer)))) return n.name.text;
  return undefined;
}

/** `'use client'` as a leading directive. */
export function isUseClient(file) {
  for (const st of file.sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) { if (st.expression.text === 'use client') return true; continue; }
    break;
  }
  return false;
}
