/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    What a generated file ACTUALLY uses — read from the TypeScript AST, not from text
 * USER STORY: As the reviewer of a build I want "this page reads governed data" to mean the code
 *             calls it, so a model cannot pass an acceptance check by writing the right words in a
 *             comment or a string.
 * ARCHITECTURE:
 *   - PURE. `ts.createSourceFile` per file (parse only, no program, no type-checker, no disk), so
 *     it is cheap enough to run every loop iteration and has no server dependency.
 *   - WHY THIS EXISTS: scoring `route`/`render` with `String.includes('os.records.add')` is
 *     forgeable — `// os.records.add` or `'os.records.add'` in a string would pass. The AST only
 *     reports an IMPORT declaration's module specifier and a CALL expression's callee path, so a
 *     comment, a string literal, a JSX text node and dead type-only code are all invisible here.
 *   - The compile gate already builds a full program over the merged tree, but it lives in
 *     `compile-gate.ts`, which this stream must not edit (stream S owns it). This module parses the
 *     same way with the same compiler for the same answer — see deviation H-review-1.
 */
import ts from 'typescript';

/** What one generated file uses, as the AST reports it. */
export type FileSymbols = {
  path: string;
  /** Module specifiers of real `import`/`export … from` declarations (type-only ones excluded). */
  imports: string[];
  /** Dotted callee paths of real call expressions, e.g. `os.datasets.query`, `createOsClient`. */
  calls: string[];
  /** Dotted property-access paths read anywhere in a value position, e.g. `os.records`. */
  reads: string[];
  /** Set when the file could not be parsed as TS/TSX — honest, never silently empty. */
  note?: string;
};

/** The dotted path of an expression (`a.b.c`), or null when it is not a plain property chain. */
function dottedPath(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = dottedPath(node.expression);
    return left === null ? null : `${left}.${node.name.text}`;
  }
  // `await os.records.add(...)` / `(os.records).add(...)` — unwrap the transparent wrappers.
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return dottedPath(node.expression);
  }
  return null;
}

/**
 * Parse one file and report what it uses. A parse failure returns an empty record WITH a note —
 * never a silent empty one, because an empty record makes acceptance checks fail, and a check must
 * fail for a reason we can state.
 */
export function fileSymbols(path: string, content: string): FileSymbols {
  const imports: string[] = [];
  const calls: string[] = [];
  const reads: string[] = [];
  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.ES2020,
      /* setParentNodes */ false,
      /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  } catch (e) {
    return { path, imports, calls, reads, note: `could not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
  // A syntactically broken file still parses (the compiler is error-tolerant), but the compile gate
  // is what rejects it — here we just report what we could see.
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // A TYPE-ONLY import proves nothing about runtime behaviour, so it does not count.
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly === true
        : node.isTypeOnly === true;
      const spec = node.moduleSpecifier;
      if (!typeOnly && spec && ts.isStringLiteral(spec)) imports.push(spec.text);
    } else if (ts.isCallExpression(node)) {
      const callee = dottedPath(node.expression);
      if (callee !== null) calls.push(callee);
    } else if (ts.isPropertyAccessExpression(node)) {
      const p = dottedPath(node);
      if (p !== null) reads.push(p);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return {
    path,
    imports: [...new Set(imports)].sort(),
    calls: [...new Set(calls)].sort(),
    reads: [...new Set(reads)].sort(),
  };
}

/** Parse every TS/TSX file of a tree. Non-TS files are skipped (nothing to read from them). */
export function usedSymbols(files: { path: string; content: string }[]): FileSymbols[] {
  return files.filter((f) => /\.(ts|tsx)$/.test(f.path)).map((f) => fileSymbols(f.path, f.content));
}

/**
 * Does this file USE the given dotted symbol? True when it appears as a call callee, as a prefix of
 * one (`os.datasets.query` satisfies `os.datasets`), or as a property read. A comment, a string
 * literal or JSX text can never satisfy it, which is the whole point.
 */
export function usesSymbol(symbols: FileSymbols, wanted: string): boolean {
  const hit = (p: string): boolean => p === wanted || p.startsWith(`${wanted}.`);
  return symbols.calls.some(hit) || symbols.reads.some(hit);
}

/** Does this file import the given module specifier (exactly, or a subpath of it)? */
export function importsModule(symbols: FileSymbols, spec: string): boolean {
  return symbols.imports.some((i) => i === spec || i.startsWith(`${spec}/`));
}
