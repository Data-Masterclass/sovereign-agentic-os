#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    i18n guard — catalog layout + key parity across the seven languages, and the hard-coded-text ratchet
 * USER STORY: As a maintainer I want CI to refuse a catalog where one language lacks a key, breaks an ICU
 *             placeholder or ships an empty string, and to refuse new English text typed straight into a module
 *             that has already been converted — so the OS never silently half-translates.
 * ARCHITECTURE:
 *   - LAYOUT (I18N-LAYOUT): `os-ui/messages/` holds exactly one folder per locale and, in each, exactly one
 *     `<namespace>.json` per namespace. The lists below mirror `os-ui/core/i18n/config.ts`; a unit test there pins
 *     the two equal. Adding a namespace is a deliberate change in both.
 *   - PARITY (I18N-PARITY): per namespace, every locale has EXACTLY the keys of English; every leaf is a non-empty
 *     string; every message parses as ICU (`@formatjs/icu-messageformat-parser`, os-ui's own dependency) with
 *     balanced rich-text tags; the placeholders, their kinds (number, plural, select, date, tag …) match English;
 *     every plural/select has an `other` branch. Plural CATEGORIES may differ, and Polish and Czech cardinal
 *     plurals MUST carry `few` and `many` (2–4 and 5+ take different forms there; `other` alone reads wrong).
 *   - RATCHET (I18N-HARDCODED): `scripts/i18n-converted.json` lists, per namespace, the files or folders a wave has
 *     converted. In those `.tsx` files a JSX text node, a string in a JSX expression (`{'Save'}`, `{on ? 'ON' :
 *     'OFF'}`), or a literal user-visible attribute (aria-label, title, placeholder, alt, …) must not carry words.
 *     Numbers, punctuation, symbols and the brand/product names in BRAND_TERMS are allowed; a deliberate exception
 *     carries `i18n-ignore` in a comment on the same or the previous line. Parsed with os-ui's own TypeScript (AST,
 *     not a grep). Later waves ADD their files under their namespace key; removing an entry is a visible diff.
 *   - `--root <dir>` runs it on another tree (the fixture tests in scripts/tests/check-i18n.test.mjs).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const repo = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
const UI = join(repo, 'os-ui');
const MESSAGES = join(UI, 'messages');
const CONVERTED = join(repo, 'scripts', 'i18n-converted.json');

export const LOCALES = ['en', 'de', 'fr', 'es', 'it', 'pl', 'cs'];
export const NAMESPACES = [
  'shell', 'common', 'settings', 'server',
  'admin', 'agents', 'connections', 'dashboards', 'data', 'files', 'governance',
  'home', 'knowledge', 'metrics', 'monitoring', 'software', 'workflows',
];
/** Names that are never translated (glossary: docs/i18n/glossary.md). Longest first. */
const BRAND_TERMS = [
  'Sovereign Agentic OS', 'Data Masterclass', 'Sovereign', 'Agentic', 'OS UI', 'OS',
  'MCP', 'Trino', 'Iceberg', 'LiteLLM', 'Langfuse', 'LangGraph', 'OpenSearch', 'Dagster', 'dbt', 'OPA', 'Docling',
  'Trivy', 'OKF', 'Superset', 'ECharts', 'Next.js', 'React', 'Node', 'Kubernetes', 'Helm', 'GitHub', 'GitLab',
];
const VISIBLE_ATTRS = new Set([
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
  'title', 'placeholder', 'alt', 'label',
]);

const problems = [];
const fail = (rule, where, detail) => problems.push(`${rule}  ${where}${detail ? ` — ${detail}` : ''}`);

// ------------------------------------------------------------------ dependencies (os-ui's own) --
function osUiRequire(name) {
  const here = fileURLToPath(new URL('..', import.meta.url));
  for (const from of [join(UI, 'package.json'), join(here, 'os-ui', 'package.json')]) {
    try { return createRequire(from)(name); } catch { /* try the next */ }
  }
  return null;
}

// ------------------------------------------------------------------------------ layout --
const listDir = (d) => (existsSync(d) ? readdirSync(d).filter((e) => !e.startsWith('.')) : []);
if (!existsSync(MESSAGES)) {
  fail('I18N-LAYOUT', relative(repo, MESSAGES), 'missing — the catalogs live in os-ui/messages/<locale>/<namespace>.json');
} else {
  for (const e of listDir(MESSAGES)) {
    if (!LOCALES.includes(e) || !statSync(join(MESSAGES, e)).isDirectory()) fail('I18N-LAYOUT', `os-ui/messages/${e}`, `not a locale folder (${LOCALES.join(', ')})`);
  }
  for (const l of LOCALES) {
    const dir = join(MESSAGES, l);
    if (!existsSync(dir)) { fail('I18N-LAYOUT', `os-ui/messages/${l}`, 'missing locale folder'); continue; }
    const files = listDir(dir);
    for (const f of files) if (!NAMESPACES.map((n) => `${n}.json`).includes(f)) fail('I18N-LAYOUT', `os-ui/messages/${l}/${f}`, 'not a known namespace file (core/i18n/config.ts NAMESPACES)');
    for (const n of NAMESPACES) if (!files.includes(`${n}.json`)) fail('I18N-LAYOUT', `os-ui/messages/${l}/${n}.json`, 'missing — every namespace exists in every locale');
  }
}

// ------------------------------------------------------------------------------ parity --
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail('I18N-PARITY', relative(repo, p), `not valid JSON: ${e.message}`); return null; }
}
/** Flatten to { 'a.b.c': value }, reporting a non-object non-string leaf. */
function flatten(obj, where, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (k.includes('.')) fail('I18N-PARITY', `${where} ${key}`, 'a key may not contain "." (it is the path separator)');
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, where, key, out);
    else out[key] = v;
  }
  return out;
}

const icu = osUiRequire('@formatjs/icu-messageformat-parser');
const TYPE = ['literal', 'argument', 'number', 'date', 'time', 'select', 'plural', 'pound', 'tag'];
/** The placeholder signature of a message: sorted `name:kind`, plus problems such as a plural without `other`. */
/** Locales whose cardinal plurals need the `few` and `many` branches (CLDR: one / few / many / other). */
export const SLAVIC_PLURAL_LOCALES = ['pl', 'cs'];
function signature(msg, where, locale = 'en') {
  const sig = new Set();
  const walk = (els) => {
    for (const el of els) {
      const kind = TYPE[el.type];
      if (kind === 'literal' || kind === 'pound') continue;
      sig.add(`${el.value}:${kind === 'plural' && el.pluralType === 'ordinal' ? 'selectordinal' : kind}`);
      if (kind === 'plural' || kind === 'select') {
        if (!el.options?.other) fail('I18N-PARITY', where, `${kind} "${el.value}" has no "other" branch`);
        if (kind === 'plural' && el.pluralType !== 'ordinal' && SLAVIC_PLURAL_LOCALES.includes(locale)) {
          const missing = ['few', 'many'].filter((c) => !el.options?.[c]);
          if (missing.length) fail('I18N-PARITY', where, `plural "${el.value}" lacks the ${missing.join(' and ')} branch${missing.length > 1 ? 'es' : ''} (${locale} needs one / few / many / other)`);
        }
        for (const o of Object.values(el.options ?? {})) walk(o.value);
      }
      if (kind === 'tag') walk(el.children ?? []);
    }
  };
  walk(icu.parse(msg, { requiresOtherClause: false }));
  return [...sig].sort().join(', ');
}

if (!icu && existsSync(MESSAGES)) {
  const msg = 'os-ui/node_modules/@formatjs/icu-messageformat-parser not installed — run `npm --prefix os-ui ci`';
  if (process.env.CI) fail('I18N-PARITY', 'icu parser', msg); else console.warn(`check-i18n: ICU checks skipped locally — ${msg}`);
}

if (existsSync(MESSAGES)) {
  for (const ns of NAMESPACES) {
    const enPath = join(MESSAGES, 'en', `${ns}.json`);
    if (!existsSync(enPath)) continue;
    const enRaw = readJson(enPath);
    if (!enRaw) continue;
    const en = flatten(enRaw, `en/${ns}.json`);
    const enSig = {};
    for (const [k, v] of Object.entries(en)) {
      const where = `en/${ns}.json ${k}`;
      if (typeof v !== 'string') { fail('I18N-PARITY', where, 'every leaf must be a string'); continue; }
      if (!v.trim()) { fail('I18N-PARITY', where, 'empty string'); continue; }
      if (icu) {
        try { enSig[k] = signature(v, where); } catch (e) { fail('I18N-PARITY', where, `ICU does not parse: ${e.message}`); }
      }
    }
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      const p = join(MESSAGES, l, `${ns}.json`);
      if (!existsSync(p)) continue;
      const raw = readJson(p);
      if (!raw) continue;
      const other = flatten(raw, `${l}/${ns}.json`);
      for (const k of Object.keys(en)) if (!(k in other)) fail('I18N-PARITY', `${l}/${ns}.json ${k}`, 'missing (English has it)');
      for (const [k, v] of Object.entries(other)) {
        const where = `${l}/${ns}.json ${k}`;
        if (!(k in en)) { fail('I18N-PARITY', where, 'extra key (English does not have it)'); continue; }
        if (typeof v !== 'string') { fail('I18N-PARITY', where, 'every leaf must be a string'); continue; }
        if (!v.trim()) { fail('I18N-PARITY', where, 'empty string'); continue; }
        if (icu && enSig[k] !== undefined) {
          try {
            const s = signature(v, where, l);
            if (s !== enSig[k]) fail('I18N-PARITY', where, `placeholders differ from English: {${s}} vs {${enSig[k]}}`);
          } catch (e) { fail('I18N-PARITY', where, `ICU does not parse: ${e.message}`); }
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------- ratchet --
const ts = osUiRequire('typescript');
const hasWords = (text) => {
  let rest = ` ${text} `;
  for (const term of BRAND_TERMS) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rest = rest.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, 'gu'), '$1');
  }
  return /\p{L}/u.test(rest);
};
const walkTsx = (p, out = []) => {
  if (!existsSync(p)) return out;
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p)) if (e !== 'node_modules' && !e.startsWith('.')) walkTsx(join(p, e), out);
  } else if (/\.tsx$/.test(p)) out.push(p);
  return out;
};

let converted = {};
if (existsSync(CONVERTED)) {
  try { converted = JSON.parse(readFileSync(CONVERTED, 'utf8')); } catch (e) { fail('I18N-HARDCODED', 'scripts/i18n-converted.json', `not valid JSON: ${e.message}`); }
}
for (const key of Object.keys(converted)) {
  if (!NAMESPACES.includes(key)) fail('I18N-HARDCODED', 'scripts/i18n-converted.json', `"${key}" is not a namespace`);
}
const entries = Object.values(converted).flat();
if (entries.length && !ts) {
  const msg = 'os-ui/node_modules/typescript not installed — run `npm --prefix os-ui ci`';
  if (process.env.CI) fail('I18N-HARDCODED', 'typescript', msg); else console.warn(`check-i18n: ratchet skipped locally — ${msg}`);
}

function checkFile(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = relative(repo, file);
  const ignored = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    return /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
  };
  const report = (node, text, what) => {
    if (!hasWords(text) || ignored(node)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    fail('I18N-HARDCODED', `${rel}:${line}`, `${what} "${text.trim().replace(/\s+/g, ' ').slice(0, 60)}" — use t('<key>') from the namespace's catalog`);
  };
  /** String literals an expression can evaluate to directly (branches of ?:, ??, ||, &&, parentheses). */
  const literalsOf = (e, out = []) => {
    if (!e) return out;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push([e, e.text]);
    else if (ts.isTemplateExpression(e)) {
      out.push([e, [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' ')]);
    } else if (ts.isParenthesizedExpression(e)) literalsOf(e.expression, out);
    else if (ts.isConditionalExpression(e)) { literalsOf(e.whenTrue, out); literalsOf(e.whenFalse, out); }
    else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
      literalsOf(e.left, out); literalsOf(e.right, out);
    }
    return out;
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text');
    else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const [n, text] of literalsOf(node.expression)) report(n, text, 'string in JSX');
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (VISIBLE_ATTRS.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name}=`);
        else if (ts.isJsxExpression(node.initializer)) for (const [n, text] of literalsOf(node.initializer.expression)) report(n, text, `${name}=`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (ts) {
  for (const [ns, list] of Object.entries(converted)) {
    for (const entry of list) {
      const p = join(repo, entry);
      if (!existsSync(p)) { fail('I18N-HARDCODED', `scripts/i18n-converted.json (${ns})`, `${entry} does not exist`); continue; }
      for (const f of walkTsx(p)) checkFile(f);
    }
  }
}

// ------------------------------------------------------------------------------ report --
if (problems.length) {
  for (const p of problems) console.error(p);
  console.error(`\ncheck-i18n: ${problems.length} problem(s). Catalogs: os-ui/messages/<locale>/<namespace>.json (docs/i18n/how-to.md).`);
  process.exit(1);
}
const files = Object.values(converted).flat().length;
console.log(`check-i18n: ok — ${LOCALES.length} locales × ${NAMESPACES.length} namespaces in parity; ${files} converted path(s) free of hard-coded text`);
