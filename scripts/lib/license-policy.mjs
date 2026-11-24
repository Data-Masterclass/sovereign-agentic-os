/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    Licence-policy library - SPDX expression evaluation, scanners for npm / Python / manifest, checks
 * USER STORY: As the owner I want one policy file enforced the same way for npm, Python and container
 *             components, so "allowed" means the same thing everywhere.
 * ARCHITECTURE: Pure functions, no network. Scanners turn each ecosystem into `{ecosystem, name, version,
 *             expression, source}`; `checkAll` classifies against licenses/policy.json (the only place the
 *             lists live), applies reviewed exceptions (unknown only) and the attribution rule.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function loadPolicy(file) {
  const p = typeof file === 'string' ? JSON.parse(readFileSync(file, 'utf8')) : file;
  for (const k of ['allow', 'forbid', 'attributionExempt']) {
    if (!Array.isArray(p[k]) || p[k].length === 0) throw new Error(`policy: "${k}" must be a non-empty array`);
  }
  p.aliases = p.aliases || {}; p.noticesFiles = p.noticesFiles || [];
  p._allow = new Map(p.allow.map((id) => [id.toLowerCase(), id]));
  p._alias = new Map(Object.entries(p.aliases).map(([k, v]) => [k.toLowerCase(), v]));
  const glob = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  p._forbid = p.forbid.map(glob);
  p.exceptable = p.exceptable || {}; p.conditions = p.conditions || {};
  p._exceptable = Object.entries(p.exceptable).flatMap(([family, globs]) => globs.map((g) => ({ family, re: glob(g) })));
  return p;
}

// The conditions a reviewed exception may carry. 'unmodified-not-linked': a weak-copyleft library used unmodified and not
// linked into our code. 'separate-program': an unmodified program that runs as its own process. Which family needs which
// is in policy.json (`conditions`).
export const EXCEPTION_CONDITIONS = ['unmodified-not-linked', 'separate-program'];

export function loadExceptions(file) {
  const e = typeof file === 'string' ? JSON.parse(readFileSync(file, 'utf8')) : file;
  const list = e.exceptions || [];
  list.forEach((x, i) => {
    for (const k of ['ecosystem', 'name', 'version', 'condition']) if (!x[k]) throw new Error(`exceptions[${i}]${x.name ? ` (${x.name})` : ''}: "${k}" is required`);
    if (typeof x.reason !== 'string' || x.reason.trim() === '') throw new Error(`exceptions[${i}] (${x.name}): a reason is required`);
    if (typeof x.reviewedBy !== 'string' || x.reviewedBy.trim() === '') throw new Error(`exceptions[${i}] (${x.name}): reviewedBy is required`);
    if (!EXCEPTION_CONDITIONS.includes(x.condition)) throw new Error(`exceptions[${i}] (${x.name}): condition must be one of ${EXCEPTION_CONDITIONS.join(', ')}`);
  });
  return { exceptions: list };
}

// ---- SPDX expression -------------------------------------------------------------------------
function tokenize(expr) {
  let s = String(expr).trim();
  if (!/SEE LICENSE IN/i.test(s)) s = s.replace(/\s*\/\s*/g, ' OR '); // legacy "MIT/GPL"
  const out = []; let atom = [];
  const flush = () => { if (atom.length) { out.push({ t: 'atom', v: atom.join(' ') }); atom = []; } };
  for (const w of s.replace(/([()])/g, ' $1 ').split(/\s+/).filter(Boolean)) {
    const u = w.toUpperCase();
    if (w === '(' || w === ')') { flush(); out.push({ t: w }); }
    else if (u === 'AND' || u === 'OR' || u === 'WITH') { flush(); out.push({ t: u }); }
    else atom.push(w);
  }
  flush(); return out;
}

function classifyAtom(raw, policy) {
  let id = raw.trim();
  if (/^SEE LICENSE IN/i.test(id) || id === '' || /^UNLICENSED$/i.test(id)) return { verdict: 'unknown', chosen: [], why: [`"${id || 'empty'}" is not a licence identifier`] };
  const alias = policy._alias.get(id.toLowerCase()); if (alias) id = alias;
  if (policy._allow.has(id.toLowerCase())) return { verdict: 'allow', chosen: [policy._allow.get(id.toLowerCase())], why: [] };
  const base = id.replace(/\+$/, '');
  if (policy._forbid.some((re) => re.test(id) || re.test(base))) return { verdict: 'forbid', chosen: [], why: [`${id} is never allowed (AGPL / EUPL / source-available)`] };
  const exc = policy._exceptable.find((e) => e.re.test(id) || e.re.test(base));
  if (exc) return { verdict: 'exceptable', chosen: [id], families: [exc.family], why: [`${id} is copyleft: allowed only through a reviewed entry in licenses/exceptions.json`] };
  return { verdict: 'unknown', chosen: [], why: [`${id} is not on the allow list or the forbid list`] };
}

const uniq = (a) => [...new Set(a)];
function combine(kind, parts) {
  if (kind === 'AND') {
    if (parts.some((p) => p.verdict === 'forbid')) return { verdict: 'forbid', chosen: [], why: parts.flatMap((p) => p.why) };
    if (parts.some((p) => p.verdict === 'unknown')) return { verdict: 'unknown', chosen: [], why: parts.flatMap((p) => p.why) };
    const ex = parts.filter((p) => p.verdict === 'exceptable');
    if (ex.length) return { verdict: 'exceptable', chosen: uniq(parts.flatMap((p) => p.chosen)), families: uniq(ex.flatMap((p) => p.families)), why: ex.flatMap((p) => p.why) };
    return { verdict: 'allow', chosen: uniq(parts.flatMap((p) => p.chosen)), why: [] };
  }
  const ok = parts.find((p) => p.verdict === 'allow'); // OR: the first allowed option, in written order
  if (ok) return { verdict: 'allow', chosen: ok.chosen, why: [] };
  const ex = parts.filter((p) => p.verdict === 'exceptable'); // else the option that needs the weakest exception (weak before gpl)
  if (ex.length) return ex.find((p) => !p.families.includes('gpl')) ?? ex[0];
  return { verdict: parts.some((p) => p.verdict === 'forbid') ? 'forbid' : 'unknown', chosen: [], why: parts.flatMap((p) => p.why) };
}

export function evaluateExpression(expr, policy) {
  const toks = tokenize(expr ?? ''); let i = 0;
  if (toks.length === 0) return { verdict: 'unknown', chosen: [], why: ['no licence declared'], expression: '' };
  const peek = () => toks[i]?.t;
  function parseOr() { const parts = [parseAnd()]; while (peek() === 'OR') { i++; parts.push(parseAnd()); } return parts.length === 1 ? parts[0] : combine('OR', parts); }
  function parseAnd() { const parts = [parseWith()]; while (peek() === 'AND') { i++; parts.push(parseWith()); } return parts.length === 1 ? parts[0] : combine('AND', parts); }
  function parseWith() { const r = parsePrimary(); if (peek() === 'WITH') { i++; if (peek() === 'atom') i++; } return r; }
  function parsePrimary() {
    if (peek() === '(') { i++; const r = parseOr(); if (peek() === ')') i++; return r; }
    if (peek() === 'atom') return classifyAtom(toks[i++].v, policy);
    i++; return { verdict: 'unknown', chosen: [], why: ['unparseable licence expression'] };
  }
  const r = parseOr();
  if (i < toks.length) return { verdict: 'unknown', chosen: [], why: [`unparseable licence expression "${expr}"`], expression: String(expr) };
  return { ...r, expression: String(expr) };
}

// ---- scanners --------------------------------------------------------------------------------
function npmLicenseField(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return '(' + l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ') + ')';
  if (l && typeof l === 'object') return l.type || '';
  return '';
}

function dedupe(deps) {
  const seen = new Map();
  for (const d of deps) { const k = `${d.ecosystem}:${d.name}@${d.version}`; if (!seen.has(k)) seen.set(k, d); }
  return [...seen.values()];
}

export function scanNodeModules(dir, source = dir) {
  const out = [];
  const walk = (nm) => {
    if (!existsSync(nm)) return;
    for (const e of readdirSync(nm, { withFileTypes: true })) {
      if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
      const roots = e.name.startsWith('@') ? readdirSync(join(nm, e.name)).map((n) => join(nm, e.name, n)) : [join(nm, e.name)];
      for (const r of roots) {
        const pj = join(r, 'package.json');
        if (existsSync(pj)) {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'));
          out.push({ ecosystem: 'npm', name: pkg.name || r.split('node_modules/').pop(), version: pkg.version || '0.0.0', expression: npmLicenseField(pkg), source });
        }
        walk(join(r, 'node_modules'));
      }
    }
  };
  walk(dir); return dedupe(out);
}

export function scanNpmLock(lock, { includeDev = false, source = 'package-lock.json' } = {}) {
  const out = [];
  for (const [path, pkg] of Object.entries(lock.packages || {})) {
    if (path === '' || !path.includes('node_modules/')) continue;
    if (pkg.link) continue;
    if (pkg.dev && !includeDev) continue;
    const name = pkg.name || path.split('node_modules/').pop();
    out.push({ ecosystem: 'npm', name, version: pkg.version || '0.0.0', expression: npmLicenseField(pkg), source });
  }
  return dedupe(out);
}

export function scanPipReport(report, source = 'pip report') {
  const out = [];
  for (const it of report.install || []) {
    const m = it.metadata || {};
    const cls = (m.classifier || []).filter((c) => /^License ::/.test(c));
    let expression = '';
    if (m.license_expression) expression = m.license_expression;
    else if (cls.length) { // several classifiers: all must be allowed (conservative); parentheses would break SPDX parsing
      expression = cls.map((c) => c.replace(/^License :: (OSI Approved :: )?/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()).join(' AND ');
    }
    else if (m.license && m.license.length <= 200 && !/\n/.test(m.license)) expression = m.license;
    const alt = m.license && m.license.length <= 200 && !/\n/.test(m.license) && m.license !== expression ? m.license : undefined;
    out.push({ ecosystem: 'python', name: m.name, version: m.version, expression, alt, source });
  }
  return dedupe(out);
}

// A BUILT image's inventory (scripts/lib/image-inventory.py): installed Python distributions (judged exactly like
// a pip report), components compiled into a wheel (its embedded SBOM; ecosystem 'embedded', named <wheel>/<component>)
// and npm packages found in the image.
export function scanImageInventory(inv, source = 'image') {
  const deps = scanPipReport({ install: (inv.python || []).map((p) => ({ metadata: p })) }, `${source} (site-packages)`);
  const seen = new Set(deps.map((d) => `${d.ecosystem}:${d.name}@${d.version}`));
  const add = (d) => { const k = `${d.ecosystem}:${d.name}@${d.version}`; if (!seen.has(k)) { seen.add(k); deps.push(d); } };
  for (const e of inv.embedded || []) add({ ecosystem: 'embedded', name: e.name, version: e.version, expression: e.expression || '', source: `${source} (embedded SBOM)` });
  for (const n of inv.npm || []) add({ ecosystem: 'npm', name: n.name, version: n.version, expression: n.expression || '', source: `${source} (${n.path})` });
  return deps;
}

// Reviewed licence DECLARATIONS (licenses/image-licence-overrides.json) for packages whose metadata states none.
// Applied only to the exact name + version, and only where the package declares nothing itself; any other
// entry for a package that is present is returned as stale (a bump, or upstream now declares a licence).
// Entries for packages that are not present at all are ignored (they belong to another image).
export function applyLicenceOverrides(deps, overrides) {
  const stale = [];
  for (const o of overrides) {
    if (!deps.some((x) => x.ecosystem === o.ecosystem && x.name === o.name)) continue;
    const d = deps.find((x) => x.ecosystem === o.ecosystem && x.name === o.name && x.version === o.version);
    if (!d || String(d.expression || '').trim() !== '') { stale.push(o); continue; }
    d.expression = o.licence; d.declaredBy = `licenses/image-licence-overrides.json (${o.evidence})`;
  }
  return stale;
}

export function scanManifest(tsv, source = 'licenses/components.tsv') {
  const out = [];
  for (const line of tsv.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const [name, version, spdx, bundled] = line.split('\t').map((s) => (s ?? '').trim());
    if (name === 'name' || !name) continue;
    if (bundled === 'no') continue; // referenced, not redistributed (e.g. local dev stand-ins)
    if (!spdx || spdx.toLowerCase() === 'n/a') continue;
    out.push({ ecosystem: 'component', name, version, expression: spdx, source });
  }
  return out;
}

export function extractPipSpecs(text, filename) {
  const specs = [];
  if (/requirements.*\.txt$/.test(filename)) {
    for (const l of text.split('\n')) { const t = l.trim(); if (t && !t.startsWith('#') && !t.startsWith('-')) specs.push(t.replace(/\s+#.*$/, '')); }
    return specs;
  }
  const lines = text.split('\n'); // join RUN continuations, dropping comment lines inside them
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*RUN\b/.test(lines[i])) continue;
    let stmt = lines[i];
    let cont = /\\\s*$/.test(lines[i]);
    while (cont && i + 1 < lines.length) {
      i++; if (/^\s*#/.test(lines[i])) continue; // a comment line neither ends nor adds to the statement
      stmt += '\n' + lines[i]; cont = /\\\s*$/.test(lines[i]);
    }
    const m = stmt.match(/pip3?\s+install\b([\s\S]*)/); if (!m) continue;
    for (const tok of m[1].replace(/\\\s*\n/g, ' ').split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const t = tok.trim().replace(/^"|"$/g, '');
      if (!t || t.startsWith('-') || t.startsWith('/') || t === '&&' || /^(&&|\|\||;)/.test(t)) continue;
      if (/^[A-Za-z0-9_.\-[\]]+\s*([=<>!~]=?|@)?/.test(t)) specs.push(t);
    }
  }
  return specs;
}

// ---- checks ----------------------------------------------------------------------------------
export function hasAttribution(name, noticesText) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_@/.-])${esc}($|[^A-Za-z0-9_/.-]|\\.(?!\\w))`, 'im').test(noticesText || '');
}

export function checkAll(deps, { policy, exceptions, noticesText = '' }) {
  const exc = exceptions.exceptions || [];
  const used = new Set();
  const results = deps.map((d) => {
    let ev = evaluateExpression(d.expression, policy);
    if (ev.verdict === 'unknown' && d.alt) { // ambiguous classifier (a bare "BSD License"): the short licence string may be exact
      const alt = evaluateExpression(d.alt, policy);
      if (alt.verdict !== 'unknown') ev = { ...alt, expression: d.alt };
    }
    const r = { ...d, verdict: ev.verdict, chosen: ev.chosen, reasons: [], status: 'pass', needsAttribution: false, attributed: false, note: '' };
    const findException = () => exc.findIndex((x) => x.ecosystem === d.ecosystem && x.name === d.name && (x.version === '*' || x.version === d.version));
    if (ev.verdict === 'forbid') { r.status = 'fail'; r.reasons.push(...ev.why, 'this licence can never be excepted'); return r; }
    if (ev.verdict === 'unknown') { // an exception can NEVER waive an unknown: it must first be resolved to an SPDX id by an alias
      r.status = 'fail';
      r.reasons.push(...ev.why, 'unknown or missing licence: resolve it to an SPDX id with an alias in licenses/policy.json (a reviewed mapping); exceptions never waive an unknown licence');
      return r;
    }
    if (ev.verdict === 'exceptable') {
      const i = findException();
      if (i < 0) { r.status = 'fail'; r.reasons.push(...ev.why, `add a reviewed exception (condition ${EXCEPTION_CONDITIONS.join(' | ')}) or replace the dependency`); return r; }
      used.add(i);
      const need = ev.families.map((f) => (policy.conditions[f] || []));
      if (!exc[i].condition || !need.every((allowedConds) => allowedConds.includes(exc[i].condition))) {
        r.status = 'fail';
        r.reasons.push(`the exception for ${d.name} needs a condition that fits ${ev.families.join('+')}: ${[...new Set(need.flat())].join(' | ')}${exc[i].condition ? ` (has "${exc[i].condition}")` : ' (has none)'}`);
        return r;
      }
      r.note = `excepted (${exc[i].condition}): ${exc[i].reason} (reviewed by ${exc[i].reviewedBy})`;
    }
    r.needsAttribution = r.chosen.some((id) => !policy.attributionExempt.includes(id));
    if (r.needsAttribution) {
      const bare = d.name.replace(/\s*\(.*\)\s*$/, '');
      r.attributed = hasAttribution(d.name, noticesText) || hasAttribution(bare, noticesText);
      if (!r.attributed) { r.status = 'fail'; r.reasons.push(`${r.chosen.join(' AND ')} requires an attribution entry for "${d.name}" in ${policy.noticesFiles.join(' or ') || 'the notices file'}`); }
    }
    return r;
  });
  results.unusedExceptions = exc.filter((_, i) => !used.has(i));
  return results;
}

// ---- ratchet: findings that existed when the policy was introduced -----------------------------
// NOT an exception: nothing here is waived. Every run still prints each one, `--strict` fails on them, a NEW
// finding fails, and an entry whose package is fixed or gone is STALE and fails - so the list only shrinks.
export function loadKnownViolations(file) {
  const k = typeof file === 'string' ? JSON.parse(readFileSync(file, 'utf8')) : file;
  const list = k.violations || [];
  list.forEach((x, i) => {
    const py = x.ecosystem === 'python'; // python resolves against a live index: keyed on package + licence, the version floats
    for (const f of ['ecosystem', 'name', py ? 'licence' : 'version']) if (!x[f]) throw new Error(`known-violations[${i}]${x.name ? ` (${x.name})` : ''}: "${f}" is required`);
    if (!py && x.version === '*') throw new Error(`known-violations[${i}] (${x.name}): an exact version is required, "*" would hide every future version`);
    if (typeof x.reason !== 'string' || x.reason.trim() === '') throw new Error(`known-violations[${i}] (${x.name}): a reason is required`);
  });
  return { violations: list };
}

// A finding is "known" only if it is not never-allowed (AGPL, EUPL, source-available: verdict forbid - those always fail) and an entry
// names its exact package version (python: its package + licence, because the index moves under us). `unchecked` = entries of an ecosystem that was not scanned this run: reported, never silent.
export function applyKnownViolations(results, known, { scanned }) {
  const list = known.violations;
  const matches = (x, r) => x.ecosystem === r.ecosystem && x.name === r.name
    && (x.ecosystem === 'python' ? x.licence === String(r.expression) : x.version === r.version); // python: a bump with the same licence stays known
  const failures = results.filter((r) => r.status === 'fail');
  const knownHits = failures.filter((r) => r.verdict !== 'forbid' && list.some((x) => matches(x, r)));
  const newFailures = failures.filter((r) => !knownHits.includes(r));
  const stale = list.filter((x) => scanned.includes(x.ecosystem) && !knownHits.some((r) => matches(x, r)));
  const unchecked = list.filter((x) => !scanned.includes(x.ecosystem));
  return { known: knownHits, newFailures, stale, unchecked };
}
