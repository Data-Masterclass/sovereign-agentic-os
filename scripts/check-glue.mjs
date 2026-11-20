#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Glue-discipline CI rules (design 00 §8.3, amended by 10 F8, plus the artifact
 *             contract): the ten rules that make imitation code fail CI, as a ratchet.
 * USER STORY: As the owner I want a change that re-codes a component, hides a failure, hard-codes
 *             a version, skips governance, or writes OS metadata into native code to be refused by
 *             CI — while today's known backlog is counted and may only shrink.
 * ARCHITECTURE:
 *   - Ten rules, one ratchet key each (`GLUE-<n>-<NAME>`). Every finding is `file:line — detail`.
 *     The import rules (1 static imports, 2 transitive reach, 9 kernel/tab) are dependency-cruiser
 *     rules in `os-ui/.dependency-cruiser.cjs`; the text rules are here. Rule 6's dynamic half
 *     (the component's own validator on generated config) is `scripts/validate-generated.sh`; its
 *     static half here demands that every registered generator has a golden fixture.
 *   - Ratchet: counts per rule against `scripts/structure-baseline.json` → `glue`. A count that
 *     GROWS fails; a count that shrinks prints "run --baseline". No rule can be switched off: a
 *     key missing from the baseline means 0 allowed.
 *   - `--root <dir>` runs against another tree (the negative-twin tests build throwaway trees);
 *     dependency-cruiser and js-yaml always come from THIS repo's os-ui/node_modules.
 *   - `--baseline` rewrites only the `glue` block; `--list <KEY>` prints every finding of a rule.
 *   - Pure reads plus one dependency-cruiser child process. No network.
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..', 'os-ui'); // where dependency-cruiser + js-yaml are installed
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(opt('--root') ?? process.cwd());
const UI = join(ROOT, 'os-ui');
const BASELINE_FILE = join(ROOT, 'scripts', 'structure-baseline.json');
const requireTool = createRequire(join(TOOLS, 'package.json'));
const yaml = requireTool('js-yaml');

export const RULES = {
  'GLUE-1-ADAPTER-DOOR': 'only core/adapters/** may call fetch(, undici, new Pool(, child_process or read a component URL key',
  'GLUE-2-CREDENTIAL-BOUNDARY': 'the LiteLLM master key / Keycloak admin secret stay in admin adapter modules; runtime, engine and worker never reach them',
  'GLUE-3-SILENT-FALLBACK': 'no empty catch, no catch returning a success-shaped literal, adapters return Fetched, the offline mock only through its production guard',
  'GLUE-4-HARDCODED-VERSION': 'no semver / image-tag literal outside charts/ and components/; no exported nodes|pools|versionFor|selfHeal*|VERSIONS',
  'GLUE-5-RECODED-FEATURE': 'no queue besides pg-boss, no cron parsing outside the Dagster YAML generator, no ranking outside OpenSearch (RRF exception), no password hashing, no OAuth AS endpoints except RFC 9728 metadata',
  'GLUE-6-VALIDATED-CONFIG': 'every config generator is registered with a golden fixture that scripts/validate-generated.sh runs through the component\'s own tool',
  'GLUE-7-UNGOVERNED-WRITE': 'every mutating route and MCP tool calls governance authorize() (OPA) before the effect',
  'GLUE-8-SETINTERVAL': 'no setInterval in server code outside core/reconcile/runtime.ts and lease heartbeats',
  'GLUE-9-KERNEL-TAB-ISOLATION': 'the kernel never imports a tab; a tab never imports another tab',
  'GLUE-10-ARTIFACT-CONTRACT': 'generated native code carries OS metadata only in the tool\'s documented extension points (dbt meta/tags, OPA data, OS-owned os/ files)',
};

const findings = Object.fromEntries(Object.keys(RULES).map((k) => [k, []]));
const add = (rule, file, line, detail) => findings[rule].push(`${file}${line ? `:${line}` : ''} — ${detail}`);

// ---------------------------------------------------------------- file sets --
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === 'public' || e === 'vendor' || (e.startsWith('.') && e !== '.well-known')) continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const SRC = /\.(ts|tsx|mjs|cjs|js)$/;
const isTest = (rel) => /\.test\.(ts|tsx|mjs)$/.test(rel) || /(^|\/)fixtures\//.test(rel) || rel.startsWith('core/testing/');
const all = ['core', 'tabs', 'worker', 'app', 'components', 'lib']
  .flatMap((d) => walk(join(UI, d)))
  .filter((f) => SRC.test(f) && !f.endsWith('.d.ts'))
  .map((f) => ({ abs: f, rel: relative(UI, f), text: readFileSync(f, 'utf8') }));
const prod = all.filter((f) => !isTest(f.rel));
const isClient = (f) => /^\s*(\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]/.test(f.text) || /(^|\/)ui\//.test(f.rel) || /^components\//.test(f.rel);
const server = prod.filter((f) => !isClient(f));
const inAdapters = (rel) => rel.startsWith('core/adapters/');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
// Strip comments (keeps offsets: comment chars become spaces) so a rule never fires on prose.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\'"`])\/\/[^\n]*/g, (m, p1) => (p1 ?? '') + m.slice((p1 ?? '').length).replace(/[^\n]/g, ' '));
for (const f of all) f.code = stripComments(f.text);
const each = (files, re, fn) => { for (const f of files) for (const m of f.code.matchAll(re)) fn(f, m, lineOf(f.code, m.index)); };

// ------------------------------------------------- rule 1: adapters only door --
const NOT_COMPONENT_URL = /^(osPublic\w*|\w*Console\w*)Url$/;
each(server.filter((f) => !inAdapters(f.rel)), /(?<![\w.$])(?:globalThis\.)?fetch\s*\(/g, (f, _m, l) => add('GLUE-1-ADAPTER-DOOR', f.rel, l, 'fetch( outside core/adapters'));
each(server.filter((f) => !inAdapters(f.rel)), /\bnew\s+Pool\s*\(/g, (f, _m, l) => add('GLUE-1-ADAPTER-DOOR', f.rel, l, 'new Pool( outside core/adapters'));
each(server.filter((f) => !inAdapters(f.rel)), /\b(?:import|require)\s*\(\s*['"](?:node:)?(undici|pg|child_process)['"]\s*\)/g, (f, m, l) => add('GLUE-1-ADAPTER-DOOR', f.rel, l, `dynamic import of ${m[1]} outside core/adapters`));
each(server.filter((f) => !inAdapters(f.rel) && f.rel !== 'core/kernel/config.ts'), /\bconfig\.(\w+Url)\b/g, (f, m, l) => {
  if (!NOT_COMPONENT_URL.test(m[1])) add('GLUE-1-ADAPTER-DOOR', f.rel, l, `component URL key config.${m[1]} outside core/adapters`);
});

// ---------------------------------------------- rule 2: credential boundary --
const CRED = /\b(litellmMasterKey|LITELLM_MASTER_KEY|keycloakAdmin\w*|KEYCLOAK_ADMIN\w*)\b/g;
const CRED_OK = /^core\/adapters\/[^/]+\/(read|write|admin)\.ts$|^core\/kernel\/config\.ts$/;
for (const f of prod) {
  if (CRED_OK.test(f.rel)) continue;
  const m = f.code.match(new RegExp(CRED.source));
  if (m) add('GLUE-2-CREDENTIAL-BOUNDARY', f.rel, lineOf(f.code, m.index), `names ${m[1]} — only an admin adapter module (core/adapters/<c>/{read,write}.ts) may`);
}

// ------------------------------------------------ rule 3: no silent fallback --
const SUCCESS = String.raw`(?:true|\[\s*\]|\{\s*\}|''|""|\x60\x60|0|\{\s*(?:ok\s*:\s*true|status\s*:\s*['"](?:ok|ready|healthy|up|green)['"])[^{}]*\})`;
const RET_SUCCESS = new RegExp(String.raw`^return\s+${SUCCESS}\s*;?$`);
const PROMISE_SWALLOW = new RegExp(String.raw`\.catch\(\s*(?:\(\s*\w*\s*(?::\s*\w+)?\s*\)|\w+)\s*=>\s*(\{\s*\}|\(\s*${SUCCESS}\s*\)|${SUCCESS})\s*\)`, 'g');
const fallbackScope = prod.filter((f) => f.rel.startsWith('core/') || /^tabs\/[^/]+\/lib\//.test(f.rel));
for (const f of fallbackScope) {
  for (const m of f.code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 1, i = m.index + m[0].length;
    while (i < f.code.length && depth) { const c = f.code[i++]; if (c === '{') depth++; else if (c === '}') depth--; }
    const body = f.code.slice(m.index + m[0].length, i - 1).trim();
    const l = lineOf(f.code, m.index);
    if (body === '') add('GLUE-3-SILENT-FALLBACK', f.rel, l, 'empty catch — return a typed failure (Fetched ok:false) or rethrow');
    else if (RET_SUCCESS.test(body)) add('GLUE-3-SILENT-FALLBACK', f.rel, l, `catch returns a success-shaped literal (${body}) — a failure must look like one`);
  }
  for (const m of f.code.matchAll(PROMISE_SWALLOW)) add('GLUE-3-SILENT-FALLBACK', f.rel, lineOf(f.code, m.index), `promise .catch swallows into ${m[1] || 'a success literal'}`);
}
for (const f of prod.filter((x) => inAdapters(x.rel) && !/\/_contract\.ts$/.test(x.rel))) {
  if (!/from\s+['"](?:@core\/adapters\/_contract|(?:\.\.?\/)+_contract)['"]/.test(f.text)) add('GLUE-3-SILENT-FALLBACK', f.rel, 0, 'adapter module does not use the Fetched contract (core/adapters/_contract.ts)');
}
each(prod.filter((f) => f.rel !== 'core/kernel/offline-mock.ts'), /\bOS_OFFLINE_MOCK\b/g, (f, _m, l) => add('GLUE-3-SILENT-FALLBACK', f.rel, l, 'reads OS_OFFLINE_MOCK directly — go through core/kernel/offline-mock.ts (refused in production)'));
const guard = all.find((f) => f.rel === 'core/kernel/offline-mock.ts');
if (guard && !/NODE_ENV|nodeEnv\s*===\s*['"]production['"]/.test(guard.code)) add('GLUE-3-SILENT-FALLBACK', guard.rel, 0, 'the offline mock guard no longer refuses NODE_ENV=production');

// ------------------------------------------------ rule 4: no hard-coded version --
const SEMVER = /(['"`])v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\1/g;
const IMAGE = /(['"`])(?![^'"`\n]*:\/\/)[a-z0-9][a-z0-9.-]*(?::\d+)?\/[a-z0-9._/-]+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})\1/g;
each(prod, SEMVER, (f, m, l) => add('GLUE-4-HARDCODED-VERSION', f.rel, l, `version literal ${m[0]} — read it from the component (adapter.health()) or the chart`));
each(prod, IMAGE, (f, m, l) => add('GLUE-4-HARDCODED-VERSION', f.rel, l, `image reference literal ${m[0]} — images are pinned in charts/ only`));
each(prod, /\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)(nodes|pools|versionFor|selfHeal\w*|VERSIONS)\b/g, (f, m, l) => add('GLUE-4-HARDCODED-VERSION', f.rel, l, `exports ${m[1]} — status and versions come from the component, not a literal table`));

// ------------------------------------------------ rule 5: no re-coded feature --
const R5 = 'GLUE-5-RECODED-FEATURE';
each(prod, /\bFOR\s+UPDATE\s+SKIP\s+LOCKED\b/gi, (f, _m, l) => add(R5, f.rel, l, 'hand-rolled job queue (SKIP LOCKED) — use pg-boss'));
each(prod, /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w."]*\b(outbox|\w*_queue)\b/gi, (f, m, l) => add(R5, f.rel, l, `queue/outbox table ${m[1]} — use pg-boss`));
each(prod, /\b(?:from|import|require)\s*\(?\s*['"](bull|bullmq|bee-queue|agenda|cron|node-cron|cron-parser|croner|node-schedule|bcrypt|bcryptjs|argon2)['"]/g, (f, m, l) => add(R5, f.rel, l, `imports ${m[1]} — a component owns this (pg-boss / Dagster / Keycloak)`));
const CRON_OK = new Set(['tabs/data/lib/dbt/schedules.ts']); // the Dagster YAML generator (os/schedules.yml)
each(prod.filter((f) => !CRON_OK.has(f.rel)), /\b(?:function\s+|const\s+|let\s+)(\w*(?:[pP]arse|[nN]ext|[mM]atch|[eE]xpand)\w*[cC]ron\w*|\w*[cC]ron\w*(?:[pP]arse|[nN]ext|[mM]atch|[eE]xpand|Fire|Tick)\w*)\s*[=(<]/g, (f, m, l) => add(R5, f.rel, l, `cron evaluation ${m[1]} — Dagster schedules own this`));
const RANK_OK = new Set(['core/kernel/rank-fusion.ts']); // RRF until OpenSearch score-ranker-processor (WP-24)
each(prod.filter((f) => !RANK_OK.has(f.rel)), /\b(?:function\s+|const\s+|let\s+)(\w*(?:rrf|RRF|[rR]ankFusion|[rR]eciprocalRank|[rR]erank|[cC]osineSim\w*)\w*)\s*[=(<]/g, (f, m, l) => add(R5, f.rel, l, `search ranking ${m[1]} — OpenSearch ranks`));
each(prod, /\b(?:crypto\.)?(scryptSync|pbkdf2Sync|scrypt|pbkdf2)\s*\(/g, (f, m, l) => add(R5, f.rel, l, `password hashing ${m[1]}( — Keycloak owns credentials (until WP-38)`));
for (const f of prod) {
  const route = f.rel.match(/^app\/(.+)\/route\.(ts|tsx)$/);
  if (!route) continue;
  const path = route[1].replace(/\([^)]*\)\//g, '');
  if (/(^|\/)\.well-known\/oauth-protected-resource(\/|$)/.test(path)) continue; // RFC 9728 resource metadata
  if (/(^|\/)(oauth\/(authorize|token|register|introspect|revoke|jwks)|\.well-known\/(oauth-authorization-server|openid-configuration|jwks\.json))(\/|$)/.test(path)) add(R5, f.rel, 0, 'OAuth authorization-server endpoint — Keycloak is the AS (until WP-38)');
}

// -------------------------------- rule 6 (static half): generators registered --
const REG_FILE = join(ROOT, 'scripts', 'glue', 'generators.json');
const REG_DIR = join(ROOT, 'scripts', 'glue', 'generators.d'); // extra registrations, one file each
const registry = existsSync(REG_FILE) ? JSON.parse(readFileSync(REG_FILE, 'utf8')) : { generators: [] };
if (existsSync(REG_DIR)) for (const e of readdirSync(REG_DIR).filter((x) => x.endsWith('.json')).sort()) {
  registry.generators = [...(registry.generators ?? []), ...(JSON.parse(readFileSync(join(REG_DIR, e), 'utf8')).generators ?? [])];
}
const registered = new Set();
for (const g of registry.generators ?? []) {
  registered.add(g.module);
  for (const p of g.parts ?? []) registered.add(p);
  if (!existsSync(join(UI, g.module))) add('GLUE-6-VALIDATED-CONFIG', g.module, 0, 'registered generator does not exist');
  const goldens = (g.goldens ?? []).filter((p) => existsSync(join(UI, p)));
  if (!goldens.length) add('GLUE-6-VALIDATED-CONFIG', g.module, 0, `no golden fixture on disk for validator ${g.validator}`);
}
// A generator is a module that writes a native artifact: a dbt project, Rego, Dagster YAML or a K8s manifest.
const EMITS = /(['"`])(dbt_project\.yml|schema\.yml|os\/schedules\.yml|[\w/-]*\.rego)\1|\bapiVersion:\s*['"`]?(apps|batch|networking\.k8s\.io)\//;
for (const f of prod.filter((x) => /\/lib\//.test(x.rel) || x.rel.startsWith('core/'))) {
  if (!registered.has(f.rel) && EMITS.test(f.code) && /\b(generate|emit|render|build)\w*\s*\(/.test(f.code)) add('GLUE-6-VALIDATED-CONFIG', f.rel, 0, 'looks like a native-config generator but is not in scripts/glue/generators.json with a golden fixture');
}

// ---------------------------------------------- rule 7: every write is governed --
const AUTHZ = /\b(authorize|authorizeAppTool|authorizeConnectionCall)\s*\(/;
const AUTHZ_FROM = /from\s+['"]@core\/(governance(\/[\w-]+)?|infra\/governed|infra\/agent-governed)['"]/;
const governed = (f) => AUTHZ.test(f.code) && (AUTHZ_FROM.test(f.text) || /^core\/(governance|infra\/governed|infra\/agent-governed)/.test(f.rel));
for (const f of prod) {
  if (!/^app\/.+\/route\.(ts|tsx)$/.test(f.rel)) continue;
  const verbs = [...f.code.matchAll(/\bexport\s+(?:async\s+)?(?:function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
  if (verbs.length && !governed(f)) add('GLUE-7-UNGOVERNED-WRITE', f.rel, 0, `${verbs.join('/')} handler without governance authorize() before the effect`);
}
const READ_TOOL = /^(get|list|search|query|preview|diff|whoami|suggest|profile|read|export|use|test|verify|explain|describe|find|check)_/;
for (const f of prod.filter((x) => /^(core\/mcp|tabs\/[^/]+\/mcp)\//.test(x.rel))) {
  if (governed(f)) continue;
  each([f], /\bname:\s*['"]([a-z][a-z0-9_]+)['"]/g, (_f, m, l) => {
    if (m[1].includes('_') && !READ_TOOL.test(m[1])) add('GLUE-7-UNGOVERNED-WRITE', f.rel, l, `MCP tool ${m[1]} mutates without governance authorize()`);
  });
}

// ------------------------------------------------------- rule 8: setInterval --
each(server.filter((f) => f.rel !== 'core/reconcile/runtime.ts'), /\bsetInterval\s*\(/g, (f, m, l) => {
  const near = f.code.split('\n').slice(Math.max(0, l - 4), l + 3).join('\n');
  if (!/lease|heartbeat/i.test(near)) add('GLUE-8-SETINTERVAL', f.rel, l, 'setInterval in server code — reconcile through core/reconcile/runtime.ts (pg-boss schedule)');
});

// ------------------------------------------- rule 10: artifact contract (static) --
const OS_KEY = /^(os|x-os|sovereign)[_-]/i;
const OS_TEXT = /\bOS (dataset|domain|principal|uid|scope)\b|\bos_(dataset|domain|principal|uid|scope|owner)\b/;
const walkYaml = (node, path, hit) => {
  if (Array.isArray(node)) node.forEach((v, i) => walkYaml(v, [...path, i], hit));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const inExt = path.some((p) => p === 'meta' || p === 'tags' || p === 'metadata');
      if (OS_KEY.test(k) && !inExt) hit(`${[...path, k].join('.')}`);
      if (k !== 'meta' && k !== 'tags' && k !== 'metadata') walkYaml(v, [...path, k], hit);
    }
  }
};
const goldenFiles = [
  ...(registry.generators ?? []).flatMap((g) => g.goldens ?? []),
].filter((p, i, a) => a.indexOf(p) === i && existsSync(join(UI, p)));
for (const g of goldenFiles) {
  let files;
  try { files = JSON.parse(readFileSync(join(UI, g), 'utf8')); } catch (e) { add('GLUE-10-ARTIFACT-CONTRACT', g, 0, `golden fixture is not JSON: ${e.message}`); continue; }
  for (const [p, content] of Object.entries(files)) {
    if (p.startsWith('os/') || typeof content !== 'string') continue; // OS-owned files are the OS's own extension point
    if (/\.ya?ml$/.test(p)) {
      let doc;
      try { doc = yaml.load(content); } catch (e) { add('GLUE-10-ARTIFACT-CONTRACT', `${g}#${p}`, 0, `YAML does not parse: ${e.message.split('\n')[0]}`); continue; }
      walkYaml(doc, [], (where) => add('GLUE-10-ARTIFACT-CONTRACT', `${g}#${p}`, 0, `OS key ${where} outside meta/tags`));
    } else if (/\.(sql|rego|py)$/.test(p)) {
      content.split('\n').forEach((line, i) => {
        if (OS_TEXT.test(line) && !/\bconfig\s*\(.*\bmeta\s*=/.test(line)) add('GLUE-10-ARTIFACT-CONTRACT', `${g}#${p}`, i + 1, `OS metadata in native code (${line.trim().slice(0, 60)}) — use config(meta=…) / OPA data`);
      });
    }
  }
}

// ---------------------------------------------- import rules: dependency-cruiser --
const CRUISE_DIRS = ['core', 'tabs', 'worker', 'app'].filter((d) => existsSync(join(UI, d)));
if (CRUISE_DIRS.length) {
  const bin = join(TOOLS, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
  if (!existsSync(bin)) { console.error(`check-glue: dependency-cruiser is not installed (${bin}) — run \`npm --prefix os-ui ci\``); process.exit(2); }
  let out;
  try {
    out = execFileSync(process.execPath, [bin, '--config', join(TOOLS, '.dependency-cruiser.cjs'), '--output-type', 'json', ...CRUISE_DIRS], { cwd: UI, maxBuffer: 1 << 28, encoding: 'utf8' });
  } catch (e) { out = e.stdout; if (!out) { console.error('check-glue: dependency-cruiser failed\n' + (e.stderr ?? e.message)); process.exit(2); } }
  for (const v of JSON.parse(out).summary.violations) {
    const rule = v.rule.name;
    if (!findings[rule]) { console.error(`check-glue: unknown dependency-cruiser rule ${rule}`); process.exit(2); }
    add(rule, v.from, 0, `imports ${v.to}${v.via?.length ? ` (via ${v.via.map((x) => x.name ?? x).join(' > ')})` : ''}`);
  }
}

// -------------------------------------------------------------------- ratchet --
const counts = Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length]));
const fullBaseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : {};
const baseline = fullBaseline.glue ?? {};

if (opt('--list')) { for (const p of findings[opt('--list')] ?? []) console.log(p); process.exit(0); }
if (argv.includes('--baseline')) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ ...fullBaseline, glue: counts }, null, 2) + '\n');
  console.log('check-glue: baseline written', JSON.stringify(counts));
  process.exit(0);
}
let failed = false;
for (const rule of Object.keys(RULES)) {
  const now = counts[rule], was = baseline[rule] ?? 0;
  if (now > was) {
    failed = true;
    console.error(`\n${rule}: ${now} (baseline ${was}) — ${now - was} new violation(s): ${RULES[rule]}`);
    for (const p of findings[rule].slice(0, 10)) console.error('  ' + p);
    if (findings[rule].length > 10) console.error(`  … node scripts/check-glue.mjs --list ${rule}`);
  } else if (now < was) console.log(`${rule}: ${now} (baseline ${was}) — ${was - now} fewer; run --baseline to lock it in`);
  else console.log(`${rule}: ${now}${now ? ' (at baseline — known backlog)' : ''}`);
}
if (failed) { console.error('\ncheck-glue: FAIL — new glue-discipline violations (design 00 §8.3). Fix them; never raise the baseline.'); process.exit(1); }
console.log('check-glue: ok (no new violations)');
