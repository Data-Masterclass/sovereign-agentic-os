#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Glue-discipline CI rules (design 00 §8.3, amended by 10 F8, plus the artifact
 *             contract C2 of 11 §4.1): the ten rules that make imitation code fail CI.
 * USER STORY: As the owner I want a change that re-codes a component, hides a failure, hard-codes
 *             a version, skips governance, or writes OS metadata into native code to be refused by
 *             CI — while today's known backlog is recorded finding by finding and may only shrink.
 * ARCHITECTURE:
 *   - Ten rules, `GLUE-<n>-<NAME>`. The code rules read the TypeScript AST (scripts/glue/ast.mjs:
 *     constant folding, import bindings, export lists), never a grep, so aliasing a global,
 *     building a string from parts or re-exporting a handler does not hide a finding. The import
 *     graph rules (1 static imports, 2 transitive reach, 9 kernel/tab) are dependency-cruiser rules
 *     (`os-ui/.dependency-cruiser.cjs`). GLUE-10 is scripts/glue/contract.mjs. GLUE-6's dynamic
 *     half (the component's own validator) is scripts/validate-generated.sh.
 *   - Ratchet BY FINGERPRINT: every finding has a stable fingerprint `<file> :: <normalised source
 *     snippet>` (no line numbers; ` #n` for repeats in one file). `scripts/structure-baseline.json`
 *     → `glue` lists today's fingerprints per rule. ANY fingerprint not in the baseline fails, so
 *     fixing an old finding never makes room for a new one. A rule missing from the baseline = none
 *     allowed; no rule can be switched off.
 *   - `--baseline` rewrites the `glue` fingerprints (keeping `$approvedRaise`). `--guard <git-ref>`
 *     compares the baseline with the one at <ref> and FAILS when this change adds any fingerprint
 *     or raises any count, unless it also sets a new `glue.$approvedRaise` text — the marker the
 *     owner sees in the diff.
 *   - `--root <dir>` runs against another tree (the negative-twin tests); dependency-cruiser,
 *     typescript, js-yaml and ajv always come from THIS repo's os-ui/node_modules.
 *   - `--list <RULE>` prints every finding of one rule with its line.
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse, fold, ts, globalRefs, lineOf, snippet, walk, exportedNames, functionName, isUseClient, unwrap, isFreeRef } from './glue/ast.mjs';
import { checkContract } from './glue/contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..', 'os-ui');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(opt('--root') ?? process.cwd());
const UI = join(ROOT, 'os-ui');
const BASELINE_FILE = join(ROOT, 'scripts', 'structure-baseline.json');
const K = ts.SyntaxKind;

export const RULES = {
  'GLUE-1-ADAPTER-DOOR': 'only core/adapters/** may call fetch, open a socket/process/DB client, or read a component URL key',
  'GLUE-2-CREDENTIAL-BOUNDARY': 'the LiteLLM master key / Keycloak admin secret stay in admin adapter modules; runtime, engine and worker never reach them',
  'GLUE-3-SILENT-FALLBACK': 'no empty catch, no catch/.catch turning a failure into a success-shaped or empty value, adapters return Fetched, the offline mock only through its production guard',
  'GLUE-4-HARDCODED-VERSION': 'no semver / image-tag value outside charts/ and components/; no exported nodes|pools|versionFor|selfHeal*|VERSIONS',
  'GLUE-5-RECODED-FEATURE': 'no queue besides pg-boss, no cron evaluation outside the Dagster YAML generator, no ranking outside OpenSearch (RRF exception), no password hashing, no OAuth AS endpoints except RFC 9728 metadata',
  'GLUE-6-VALIDATED-CONFIG': 'every native-config generator is registered with golden fixtures that scripts/validate-generated.sh runs through the component\'s own tool',
  'GLUE-7-UNGOVERNED-WRITE': 'every mutating route and MCP tool calls governance authorize() (OPA) before the effect',
  'GLUE-8-SETINTERVAL': 'no setInterval in server code outside core/reconcile/runtime.ts and lease heartbeats',
  'GLUE-9-KERNEL-TAB-ISOLATION': 'the kernel never imports a tab; a tab never imports another tab',
  'GLUE-10-ARTIFACT-CONTRACT': 'generated native code carries OS metadata only in the tool\'s documented extension points (artifact contract C2)',
};

const raw = Object.fromEntries(Object.keys(RULES).map((k) => [k, []]));
/** key = the stable part of the fingerprint (normalised snippet / detail, never a line number). */
const add = (rule, file, line, key, detail = key) => raw[rule].push({ file, line, key: key.replace(/\s+/g, ' ').trim(), detail });

// ---------------------------------------------------------------- file sets --
const walkDir = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === 'public' || e === 'vendor' || (e.startsWith('.') && e !== '.well-known')) continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walkDir(p, out) : out.push(p);
  }
  return out;
};
const SRC = /\.(ts|tsx|mjs|cjs|js)$/;
const isTest = (rel) => /\.test\.(ts|tsx|mjs)$/.test(rel) || /(^|\/)fixtures\//.test(rel) || rel.startsWith('core/testing/');
const all = ['core', 'tabs', 'worker', 'app', 'components', 'lib']
  .flatMap((d) => walkDir(join(UI, d)))
  .filter((f) => SRC.test(f) && !f.endsWith('.d.ts'))
  .map((f) => { const rel = relative(UI, f).split('\\').join('/'); return parse(rel, readFileSync(f, 'utf8')); });
const prod = all.filter((f) => !isTest(f.rel));
// Client code = a `'use client'` module, or a React component file (.tsx) under ui/ or components/.
// A plain .ts under ui/ is NOT client code by location alone.
const isClient = (f) => isUseClient(f) || (f.rel.endsWith('.tsx') && (/(^|\/)ui\//.test(f.rel) || f.rel.startsWith('components/')));
const server = prod.filter((f) => !isClient(f));
const inAdapters = (rel) => rel.startsWith('core/adapters/');

// ------------------------------------------------- rule 1: adapters only door --
const R1 = 'GLUE-1-ADAPTER-DOOR';
const COMPONENT_MODULE = /^(node:)?(child_process|http|https|http2|net|tls|dgram)$|^(pg|pg-pool|undici|postgres|ioredis|redis|kafkajs|trino-client|@opensearch-project\/opensearch|minio|@aws-sdk\/[\w-]+)(\/.*)?$/;
const NOT_COMPONENT_URL = /^(osPublic\w*|\w*Console\w*)Url$/;
for (const f of server.filter((x) => !inAdapters(x.rel))) {
  for (const n of globalRefs(f, 'fetch')) add(R1, f.rel, lineOf(f, n), `fetch: ${snippet(f, n.parent ?? n)}`, 'fetch outside core/adapters');
  for (const i of f.imports) {
    if (i.kind === 'static' || i.kind === 'type') continue; // static imports: dependency-cruiser (below)
    if (i.spec === null) add(R1, f.rel, lineOf(f, i.node), `non-literal ${i.kind}: ${snippet(f, i.node)}`, `${i.kind}() with a specifier that cannot be resolved statically — the adapter door cannot be verified`);
    else if (COMPONENT_MODULE.test(i.spec)) add(R1, f.rel, lineOf(f, i.node), `${i.kind} ${i.spec}`, `${i.kind} of ${i.spec} outside core/adapters`);
  }
  walk(f, (n) => {
    if (ts.isNewExpression(n)) {
      const c = unwrap(n.expression);
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
      const b = ts.isIdentifier(c) ? f.bindings.get(c.text) : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? f.bindings.get(c.expression.text) : undefined;
      if (name === 'Pool' || (b && COMPONENT_MODULE.test(b.module) && /^(Client|Pool|Socket|Agent)$/.test(name))) add(R1, f.rel, lineOf(f, n), `new ${snippet(f, c)}`, `new ${snippet(f, c)}( outside core/adapters`);
    }
    const urlKey = (k) => typeof k === 'string' && /Url$/.test(k) && !NOT_COMPONENT_URL.test(k);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'config' && urlKey(n.name.text) && f.rel !== 'core/kernel/config.ts') add(R1, f.rel, lineOf(f, n), `config.${n.name.text}`, `component URL key config.${n.name.text} outside core/adapters`);
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'config' && urlKey(fold(f, n.argumentExpression))) add(R1, f.rel, lineOf(f, n), `config[${fold(f, n.argumentExpression)}]`, `component URL key config['${fold(f, n.argumentExpression)}'] outside core/adapters`);
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isIdentifier(unwrap(n.initializer)) && unwrap(n.initializer).text === 'config') {
      for (const el of n.name.elements) { const k = (el.propertyName ?? el.name).getText(f.sf); if (urlKey(k)) add(R1, f.rel, lineOf(f, el), `{ ${k} } = config`, `component URL key ${k} destructured from config outside core/adapters`); }
    }
  });
}

// ---------------------------------------------- rule 2: credential boundary --
const R2 = 'GLUE-2-CREDENTIAL-BOUNDARY';
const CRED_NAME = /^(litellmMasterKey|keycloakAdmin\w*)$/;
const CRED_VALUE = /MASTER_KEY|^KEYCLOAK_ADMIN\w*$/; // incl. a scan of process.env for `*MASTER_KEY`
const CRED_OK = /^core\/adapters\/[^/]+\/(read|write|admin)\.ts$|^core\/kernel\/config\.ts$/;
const CRED_ZONE = /^(core\/runtime|tabs\/agents\/lib\/engine|worker)\//;
const CRED_MODULE = /(^|\/|@)core\/infra\/litellm-(admin|write)(\.ts)?$|(^|\/|@)core\/adapters\/(litellm|keycloak)\/(write|admin)(\.ts)?$/;
for (const f of prod.filter((x) => !CRED_OK.test(x.rel))) {
  walk(f, (n) => {
    if (ts.isIdentifier(n) && (CRED_NAME.test(n.text) || CRED_VALUE.test(n.text)) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) add(R2, f.rel, lineOf(f, n), `name ${n.text}`, `names ${n.text} — only an admin adapter module (core/adapters/<c>/{read,write}.ts) may`);
    if ((ts.isStringLiteral(n) || ts.isTemplateExpression(n) || ts.isBinaryExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CRED_VALUE.test(fold(f, n) ?? '')) {
      add(R2, f.rel, lineOf(f, n), `value ${fold(f, n)}`, `names ${fold(f, n)} — only an admin adapter module may`); return false;
    }
  });
  if (CRED_ZONE.test(f.rel)) for (const i of f.imports) if (i.kind !== 'static' && i.kind !== 'type' && i.spec && CRED_MODULE.test(i.spec)) add(R2, f.rel, lineOf(f, i.node), `${i.kind} ${i.spec}`, `${i.kind} of the admin module ${i.spec} from the runtime/engine/worker`);
}

// ------------------------------------------------ rule 3: no silent fallback --
const R3 = 'GLUE-3-SILENT-FALLBACK';
const fallbackLiteral = (e, file, seen = new Set()) => {
  e = unwrap(e);
  if (!e) return false;
  if (e.kind === K.TrueKeyword || e.kind === K.NullKeyword) return true;
  if (ts.isIdentifier(e) && e.text === 'undefined') return true;
  if (ts.isVoidExpression(e)) return true;
  if (ts.isArrayLiteralExpression(e) && e.elements.length === 0) return true;
  if (ts.isObjectLiteralExpression(e) && e.properties.length === 0) return true;
  if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === '') return true;
  if (ts.isNumericLiteral(e) && e.text === '0') return true;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && /^(Map|Set|Array)$/.test(e.expression.text) && !(e.arguments?.length)) return true;
  // `return empty()` where `empty` is a function in this file whose body is itself a fallback.
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.arguments.length === 0 && file) {
    const target = unwrap(file.consts.get(e.expression.text)) ?? file.fns.get(e.expression.text);
    if (target && !seen.has(target) && (ts.isArrowFunction(target) || ts.isFunctionExpression(target) || ts.isFunctionDeclaration(target))) { seen.add(target); return swallowBody(target.body, file, seen); }
  }
  if (ts.isObjectLiteralExpression(e)) return e.properties.some((p) => ts.isPropertyAssignment(p) && p.name && /^(ok|success|healthy)$/.test(p.name.getText()) && unwrap(p.initializer).kind === K.TrueKeyword || ts.isPropertyAssignment(p) && p.name?.getText() === 'status' && /^['"`](ok|ready|healthy|up|green)['"`]$/.test(p.initializer.getText()));
  return false;
};
const significant = (stmts) => stmts.filter((s) => !ts.isEmptyStatement(s) && !(ts.isExpressionStatement(s) && ts.isVoidExpression(s.expression)));
const swallowBody = (body, file, seen) => {
  if (!body) return false;
  if (ts.isBlock(body)) {
    const s = significant(body.statements);
    return s.length === 0 || (s.length === 1 && ts.isReturnStatement(s[0]) && (!s[0].expression || fallbackLiteral(s[0].expression, file, seen)));
  }
  return fallbackLiteral(body, file, seen);
};
const swallowFn = (f, arg) => {
  arg = unwrap(arg);
  if (ts.isIdentifier(arg)) { if (/^(noop|ignore|swallow)$/i.test(arg.text)) return true; arg = unwrap(f.consts.get(arg.text)); }
  return !!arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && swallowBody(arg.body, f);
};
const fallbackScope = server.filter((f) => /^(core|worker|app)\//.test(f.rel) || /^tabs\/[^/]+\/(lib|mcp)\//.test(f.rel));
for (const f of fallbackScope) {
  walk(f, (n) => {
    if (ts.isCatchClause(n)) {
      const s = significant(n.block.statements);
      if (s.length === 0) add(R3, f.rel, lineOf(f, n), `empty catch: ${snippet(f, n, 60)}`, 'empty catch — return a typed failure (Fetched ok:false) or rethrow');
      else if (s.length === 1 && ts.isReturnStatement(s[0]) && (!s[0].expression || fallbackLiteral(s[0].expression, f))) add(R3, f.rel, lineOf(f, n), `catch → ${snippet(f, s[0], 60)}`, `catch turns a failure into \`${snippet(f, s[0], 40)}\` — a failure must look like one`);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch' && n.arguments.length === 1 && swallowFn(f, n.arguments[0])) {
      add(R3, f.rel, lineOf(f, n), `.catch(${snippet(f, n.arguments[0], 50)})`, `promise .catch(${snippet(f, n.arguments[0], 40)}) swallows the failure`);
    }
    // `.then(onFulfilled, onRejected)`: the rejection handler is a `.catch` too.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'then' && n.arguments.length === 2 && swallowFn(f, n.arguments[1])) {
      add(R3, f.rel, lineOf(f, n), `.then(…, ${snippet(f, n.arguments[1], 50)})`, `promise .then(…, ${snippet(f, n.arguments[1], 40)}) swallows the rejection`);
    }
  });
}
for (const f of prod.filter((x) => inAdapters(x.rel) && !/\/_contract\.ts$/.test(x.rel))) {
  if (!f.imports.some((i) => i.spec && /(^@core\/adapters\/_contract$|(^|\/)_contract(\.ts)?$)/.test(i.spec))) add(R3, f.rel, 0, 'no Fetched contract', 'adapter module does not use the Fetched contract (core/adapters/_contract.ts)');
}
for (const f of prod.filter((x) => x.rel !== 'core/kernel/offline-mock.ts')) {
  walk(f, (n) => { if ((ts.isStringLiteral(n) || ts.isBinaryExpression(n) || ts.isTemplateExpression(n)) && fold(f, n) === 'OS_OFFLINE_MOCK') { add(R3, f.rel, lineOf(f, n), 'reads OS_OFFLINE_MOCK', 'reads OS_OFFLINE_MOCK directly — go through core/kernel/offline-mock.ts (refused in production)'); return false; } if (ts.isPropertyAccessExpression(n) && n.name.text === 'OS_OFFLINE_MOCK') add(R3, f.rel, lineOf(f, n), 'reads OS_OFFLINE_MOCK', 'reads OS_OFFLINE_MOCK directly — go through core/kernel/offline-mock.ts'); });
}
const guard = all.find((f) => f.rel === 'core/kernel/offline-mock.ts');
if (guard && !/nodeEnv\s*===\s*['"]production['"]|NODE_ENV/.test(guard.text)) add(R3, guard.rel, 0, 'guard lost', 'the offline mock guard no longer refuses NODE_ENV=production');

// ------------------------------------------------ rule 4: no hard-coded version --
const R4 = 'GLUE-4-HARDCODED-VERSION';
const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IMAGE = /^(?:([a-z0-9][a-z0-9.-]*(?::\d+)?)\/)?((?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*)(?::([A-Za-z0-9_][A-Za-z0-9._-]{0,127}))?(@sha256:[0-9a-f]{64})?$/;
const isImage = (s) => {
  if (s.includes('://') || !/[:@]/.test(s)) return false;
  const m = s.match(IMAGE); if (!m) return false;
  const [, , repo, tag, digest] = m;
  if (digest) return true;
  if (!tag || !/\d/.test(tag) || /^(sha\d+|md5|ds|v|id)$/.test(repo)) return false;
  // `name:1234` is a host:port; an image without a registry/path needs a dotted or lettered tag.
  return s.includes('/') ? true : /[.\-a-zA-Z]/.test(tag) && /\d+\.\d+/.test(tag);
};
const STRINGY = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === K.PlusToken) || (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'join');
for (const f of prod) {
  walk(f, (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isExternalModuleReference(n)) return false;
    if (ts.isCallExpression(n) && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) return false;
    if (STRINGY(n)) {
      const v = fold(f, n);
      if (v !== undefined) {
        if (SEMVER.test(v)) add(R4, f.rel, lineOf(f, n), `version ${v}`, `version value '${v}' — read it from the component (adapter.health()) or the chart`);
        else if (isImage(v)) add(R4, f.rel, lineOf(f, n), `image ${v}`, `image reference '${v}' — images are pinned in charts/ only`);
        return false;
      }
    }
  });
  for (const e of exportedNames(f)) if (/^(nodes|pools|versionFor|selfHeal\w*|VERSIONS)$/.test(e.name) || /^(nodes|pools|versionFor|selfHeal\w*|VERSIONS)$/.test(e.local)) add(R4, f.rel, lineOf(f, e.node), `export ${e.name}`, `exports ${e.name} — status and versions come from the component, not a literal table`);
}

// ------------------------------------------------ rule 5: no re-coded feature --
const R5 = 'GLUE-5-RECODED-FEATURE';
const DENY_MODULE = /^(bull|bullmq|bee-queue|agenda|p-queue|fastq|better-queue|queue|cron|node-cron|cron-parser|croner|node-schedule|later|bcrypt|bcryptjs|argon2|@node-rs\/(argon2|bcrypt)|scrypt-js)$/;
const CRON_OK = new Set(['tabs/data/lib/dbt/schedules.ts']); // the Dagster YAML generator (os/schedules.yml)
const RANK_OK = new Set(['core/kernel/rank-fusion.ts']); // RRF until OpenSearch score-ranker-processor (WP-24)
// Matched on the lower-cased declared name. Verbs matter: `teardownCron` manages a CronJob object,
// `nextCronRun` evaluates an expression; `refuse`/`Langfuse` are not `fuse…`.
const CRON_FN = /(parse|next|match|expand|eval|compute|due|fire)\w*cron|cron\w*(parse|next|match|expand|eval|fire|due|tick)|nextfire|firetime|nexttick|nextoccurrence|nextrun(at|time)?$|nexttrigger/;
const RANK_FN = /^rrf|rrf$|rankfusion|reciprocalrank|rerank|^fuse(scores?|ranks?|results?|lists?|hits)?$|^fuse\w*score|bm25score|cosine/;
const HASH_NAME = /^(scrypt|scryptSync|pbkdf2|pbkdf2Sync|argon2\w*|bcrypt\w*|hashPassword|verifyPassword)$/;
for (const f of prod) {
  for (const i of f.imports) if (i.kind !== 'type' && i.spec && DENY_MODULE.test(i.spec)) add(R5, f.rel, lineOf(f, i.node), `import ${i.spec}`, `imports ${i.spec} — a component owns this (pg-boss / Dagster / Keycloak)`);
  walk(f, (n) => {
    if (STRINGY(n)) {
      const v = fold(f, n);
      if (v !== undefined) {
        if (/FOR\s+UPDATE\s+SKIP\s+LOCKED/i.test(v)) add(R5, f.rel, lineOf(f, n), `SKIP LOCKED: ${v.replace(/\s+/g, ' ').slice(0, 70)}`, 'hand-rolled job queue (SKIP LOCKED) — use pg-boss');
        const t = v.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w."]*?\b(outbox|\w*_queue)\b/i);
        if (t) add(R5, f.rel, lineOf(f, n), `table ${t[1]}`, `queue/outbox table ${t[1]} — use pg-boss`);
        return false;
      }
    }
    const fn = functionName(n);
    if (fn && CRON_FN.test(fn.toLowerCase()) && !CRON_OK.has(f.rel)) add(R5, f.rel, lineOf(f, n), `cron fn ${fn}`, `cron evaluation ${fn} — Dagster schedules own this`);
    if (fn && RANK_FN.test(fn.toLowerCase()) && !RANK_OK.has(f.rel)) add(R5, f.rel, lineOf(f, n), `rank fn ${fn}`, `search ranking ${fn} — OpenSearch ranks`);
    // The RRF formula itself, whatever the function is called: 1 / (k + rank) with k = 60.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === K.SlashToken && unwrap(n.left).getText(f.sf) === '1' && !RANK_OK.has(f.rel)) {
      const d = unwrap(n.right);
      if (ts.isBinaryExpression(d) && d.operatorToken.kind === K.PlusToken && [d.left, d.right].some((x) => /^(60|k|K|RRF_K)$/.test(unwrap(x).getText(f.sf)))) add(R5, f.rel, lineOf(f, n), `rrf ${snippet(f, n, 40)}`, `reciprocal-rank fusion (${snippet(f, n, 30)}) — OpenSearch ranks`);
    }
    if (ts.isIdentifier(n) && HASH_NAME.test(n.text) && !(ts.isImportSpecifier(n.parent))) add(R5, f.rel, lineOf(f, n), `hash ${n.text}`, `password hashing ${n.text} — Keycloak owns credentials (until WP-38)`);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'update' && n.arguments.length && /pass|pwd|\bpw\b|^pw$|secret|credential/i.test(n.arguments[0].getText(f.sf)) && /createHash|createHmac/.test(n.expression.expression.getText(f.sf))) add(R5, f.rel, lineOf(f, n), `hash ${snippet(f, n, 50)}`, 'password hashing via createHash — Keycloak owns credentials (until WP-38)');
  });
  const route = f.rel.match(/^app\/(.+)\/route\.(ts|tsx)$/);
  if (route) {
    const path = route[1].replace(/\([^)]*\)\//g, '');
    if (!/(^|\/)\.well-known\/oauth-protected-resource(\/|$)/.test(path) && /(^|\/)(oauth\/(authorize|token|register|introspect|revoke|jwks)|\.well-known\/(oauth-authorization-server|openid-configuration|jwks\.json))(\/|$)/.test(path)) add(R5, f.rel, 0, 'oauth AS route', 'OAuth authorization-server endpoint — Keycloak is the AS (until WP-38)');
  }
}

// -------------------------------- rule 6 (static half): generators registered --
const R6 = 'GLUE-6-VALIDATED-CONFIG';
const REG_FILE = join(ROOT, 'scripts', 'glue', 'generators.json');
const REG_DIR = join(ROOT, 'scripts', 'glue', 'generators.d');
const registry = existsSync(REG_FILE) ? JSON.parse(readFileSync(REG_FILE, 'utf8')) : { generators: [] };
if (existsSync(REG_DIR)) for (const e of readdirSync(REG_DIR).filter((x) => x.endsWith('.json')).sort()) registry.generators = [...(registry.generators ?? []), ...(JSON.parse(readFileSync(join(REG_DIR, e), 'utf8')).generators ?? [])];
const registered = new Set();
for (const g of registry.generators ?? []) {
  registered.add(g.module); for (const p of g.parts ?? []) registered.add(p);
  if (!existsSync(join(UI, g.module))) add(R6, g.module, 0, 'missing module', 'registered generator does not exist');
  if (!(g.goldens ?? []).some((p) => existsSync(join(UI, p)))) add(R6, g.module, 0, 'no golden', `no golden fixture on disk for validator ${g.validator}`);
}
const NATIVE_FILE = /(^|\/)(dbt_project|schema|sources|kustomization|profiles)\.ya?ml$|\.rego$|\.vl\.json$|(^|\/)graph\.mjs$|(^|\/)definitions\.py$|(^|\/)guardrails\.json$|(^|\/)app\.spec\.json$/;
for (const f of prod.filter((x) => (/\/lib\//.test(x.rel) || x.rel.startsWith('core/')) && !registered.has(x.rel))) {
  let found;
  walk(f, (n) => { if (!found && STRINGY(n)) { const v = fold(f, n); if (v !== undefined) { if (NATIVE_FILE.test(v)) found = v; return false; } } return !found; });
  if (found) add(R6, f.rel, 0, `native file ${found}`, `writes or names native config '${found}' but is not registered in scripts/glue/generators.json with a golden fixture`);
}

// ---------------------------------------------- rule 7: every write is governed --
const R7 = 'GLUE-7-UNGOVERNED-WRITE';
const AUTHZ_FN = new Set(['authorize', 'authorizeAppTool', 'authorizeConnectionCall']);
const AUTHZ_MODULE = /^@core\/(governance(\/[\w-]+)?|infra\/governed|infra\/agent-governed)$/;
const isGovernanceModule = (rel) => /^core\/(governance\/|infra\/governed\.ts$|infra\/agent-governed\.ts$)/.test(rel);
const callsAuthorize = (f) => {
  let yes = false;
  walk(f, (n) => {
    if (yes || !ts.isCallExpression(n)) return !yes;
    const c = unwrap(n.expression);
    if (ts.isIdentifier(c)) {
      const b = f.bindings.get(c.text);
      if ((b && AUTHZ_MODULE.test(b.module) && AUTHZ_FN.has(b.name)) || (isGovernanceModule(f.rel) && AUTHZ_FN.has(c.text))) yes = true;
    } else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && AUTHZ_FN.has(c.name.text)) {
      const b = f.bindings.get(c.expression.text);
      if (b && AUTHZ_MODULE.test(b.module)) yes = true;
    }
    return !yes;
  });
  return yes;
};
for (const f of prod.filter((x) => /^app\/.+\/route\.(ts|tsx)$/.test(x.rel))) {
  const verbs = exportedNames(f).map((e) => e.name).filter((n) => /^(POST|PUT|PATCH|DELETE)$/.test(n));
  if (verbs.length && !callsAuthorize(f)) add(R7, f.rel, 0, `${verbs.sort().join('/')} ungoverned`, `${verbs.join('/')} handler without a governance authorize() call before the effect`);
}
const READ_TOOL = /^(get|list|search|query|preview|diff|whoami|suggest|profile|read|export|use|test|verify|explain|describe|find|check)_/;
for (const f of prod.filter((x) => /^(core\/mcp|tabs\/[^/]+\/mcp)\//.test(x.rel))) {
  if (callsAuthorize(f)) continue;
  walk(f, (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(f.sf) === 'name') {
      const v = fold(f, n.initializer);
      if (v && /^[a-z][a-z0-9_]+$/.test(v) && v.includes('_') && !READ_TOOL.test(v)) add(R7, f.rel, lineOf(f, n), `tool ${v}`, `MCP tool ${v} mutates without a governance authorize() call`);
    }
  });
}

// ------------------------------------------------------- rule 8: setInterval --
const R8 = 'GLUE-8-SETINTERVAL';
const INTERVAL_OK = (rel) => rel === 'core/reconcile/runtime.ts' || /(^|\/)[^/]*lease[^/]*\.ts$/.test(rel); // lease heartbeats live in *lease*.ts
for (const f of server.filter((x) => !INTERVAL_OK(x.rel))) {
  for (const n of globalRefs(f, 'setInterval')) add(R8, f.rel, lineOf(f, n), `setInterval: ${snippet(f, n.parent ?? n, 60)}`, 'setInterval in server code — reconcile through core/reconcile/runtime.ts (pg-boss schedule)');
  // A setTimeout that re-schedules the function it runs in is a setInterval by another name.
  for (const n of globalRefs(f, 'setTimeout')) {
    const call = n.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== n || !call.arguments.length) continue;
    let enclosing;
    for (let p = call.parent; p && !enclosing; p = p.parent) { const nm = functionName(p) ?? (ts.isFunctionDeclaration(p) && p.name?.text); if (nm) enclosing = nm; else if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) { const v = p.parent; if (ts.isVariableDeclaration(v) && ts.isIdentifier(v.name)) enclosing = v.name.text; } }
    const cb = unwrap(call.arguments[0]);
    const callsSelf = enclosing && ((ts.isIdentifier(cb) && cb.text === enclosing) || ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.body.getText(f.sf).match(new RegExp(`\\b${enclosing}\\s*\\(`))));
    if (callsSelf) add(R8, f.rel, lineOf(f, call), `self-rescheduling setTimeout: ${enclosing}`, `setTimeout re-schedules ${enclosing}() — a timer loop; reconcile through core/reconcile/runtime.ts (pg-boss schedule)`);
  }
}

// ------------------------- rule 9 (dynamic half): folded import()/require() targets --
const R9 = 'GLUE-9-KERNEL-TAB-ISOLATION';
const tabOf = (f, spec) => {
  if (spec.startsWith('@tabs/')) return spec.split('/')[1];
  if (spec.startsWith('.')) { const p = posix.normalize(posix.join(posix.dirname(f.rel), spec)); return p.startsWith('tabs/') ? p.split('/')[1] : undefined; }
  return undefined;
};
for (const f of all) {
  for (const i of f.imports) {
    if (i.kind === 'static' || i.kind === 'type' || !i.spec) continue;
    const t = tabOf(f, i.spec);
    if (!t) continue;
    if (f.rel.startsWith('core/')) add(R9, f.rel, lineOf(f, i.node), `${i.kind} ${i.spec}`, `the kernel ${i.kind}s ${i.spec}`);
    else if (f.rel.startsWith('tabs/') && f.rel.split('/')[1] !== t) add(R9, f.rel, lineOf(f, i.node), `${i.kind} ${i.spec}`, `a tab ${i.kind}s another tab: ${i.spec}`);
  }
}

// ------------------------------------------- rule 10: artifact contract (C2) --
const goldenPaths = [...new Set((registry.generators ?? []).flatMap((g) => g.goldens ?? []))].filter((p) => existsSync(join(UI, p)));
const goldens = [];
for (const g of goldenPaths) {
  try { goldens.push({ id: g, files: JSON.parse(readFileSync(join(UI, g), 'utf8')) }); } catch (e) { add('GLUE-10-ARTIFACT-CONTRACT', g, 0, 'not JSON', `golden fixture is not JSON: ${e.message}`); }
}
for (const x of checkContract(goldens)) add('GLUE-10-ARTIFACT-CONTRACT', x.file, x.line, x.key, x.detail);

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
    if (!raw[v.rule.name]) { console.error(`check-glue: unknown dependency-cruiser rule ${v.rule.name}`); process.exit(2); }
    // A package edge resolves to wherever node_modules lives on this machine: fingerprint the package name.
    const pkg = (p) => { const i = p.lastIndexOf('node_modules/'); if (i < 0) return p; const parts = p.slice(i + 13).split('/'); return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]; };
    add(v.rule.name, v.from, 0, `imports ${pkg(v.to)}`, `imports ${pkg(v.to)}${v.via?.length ? ` (via ${v.via.map((x) => x.name ?? x).join(' > ')})` : ''}`);
  }
}

// ------------------------------------------------------- fingerprints + ratchet --
const findings = {};
for (const [rule, list] of Object.entries(raw)) {
  const seen = new Map();
  findings[rule] = list
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.key.localeCompare(b.key))
    .map((x) => { const base = `${x.file} :: ${x.key}`; const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return { ...x, fp: n > 1 ? `${base} #${n}` : base }; });
}
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
const fullBaseline = readJson(BASELINE_FILE);
const baseline = fullBaseline.glue ?? {};
const fps = (block, rule) => new Set(Array.isArray(block?.[rule]) ? block[rule] : []);

if (opt('--list')) { for (const x of findings[opt('--list')] ?? []) console.log(`${x.file}${x.line ? `:${x.line}` : ''} — ${x.detail}`); process.exit(0); }

if (argv.includes('--baseline')) {
  const glue = { ...(baseline.$approvedRaise ? { $approvedRaise: baseline.$approvedRaise } : {}) };
  for (const rule of Object.keys(RULES)) glue[rule] = findings[rule].map((x) => x.fp);
  writeFileSync(BASELINE_FILE, JSON.stringify({ ...fullBaseline, glue }, null, 2) + '\n');
  console.log('check-glue: baseline written', JSON.stringify(Object.fromEntries(Object.keys(RULES).map((r) => [r, findings[r].length]))));
  process.exit(0);
}

if (opt('--guard')) {
  // The baseline may only shrink. Compare with the baseline at <ref> (the PR's base / the pushed-over commit).
  const ref = opt('--guard');
  let base = {};
  try { base = JSON.parse(execFileSync('git', ['show', `${ref}:scripts/structure-baseline.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (e) { console.error(`check-glue --guard: cannot read scripts/structure-baseline.json at ${ref}: ${String(e.stderr ?? e.message).trim()}`); process.exit(2); }
  const raised = [];
  for (const rule of Object.keys(RULES)) for (const fp of fps(baseline, rule)) if (!fps(base.glue, rule).has(fp)) raised.push(`${rule}: + ${fp}`);
  for (const [k, v] of Object.entries(fullBaseline)) if (typeof v === 'number' && v > (typeof base[k] === 'number' ? base[k] : 0)) raised.push(`${k}: ${base[k] ?? 0} → ${v}`);
  const marker = baseline.$approvedRaise, baseMarker = base.glue?.$approvedRaise;
  if (!raised.length) { console.log(`check-glue --guard: ok — the baseline did not grow against ${ref}`); process.exit(0); }
  if (marker && marker !== baseMarker) {
    console.log(`check-glue --guard: the baseline GROWS by ${raised.length} entr${raised.length === 1 ? 'y' : 'ies'} against ${ref}, approved in this change by:\n  $approvedRaise: ${marker}\nThe owner must see and accept this marker in the diff.`);
    for (const r of raised.slice(0, 20)) console.log('  ' + r);
    process.exit(0);
  }
  console.error(`check-glue --guard: FAIL — this change raises the baseline by ${raised.length} entr${raised.length === 1 ? 'y' : 'ies'} against ${ref} without a new \`glue.$approvedRaise\` marker:`);
  for (const r of raised.slice(0, 30)) console.error('  ' + r);
  console.error('Fix the new findings instead. Raising the baseline needs an explicit, owner-visible `"$approvedRaise": "<why>"` in scripts/structure-baseline.json → glue.');
  process.exit(1);
}

let failed = false;
for (const rule of Object.keys(RULES)) {
  const allowed = fps(baseline, rule);
  const fresh = findings[rule].filter((x) => !allowed.has(x.fp));
  const now = new Set(findings[rule].map((x) => x.fp));
  const fixed = [...allowed].filter((fp) => !now.has(fp)).length;
  if (fresh.length) {
    failed = true;
    console.error(`\n${rule}: ${findings[rule].length} (baseline ${allowed.size}) — ${fresh.length} new violation(s): ${RULES[rule]}`);
    for (const x of fresh.slice(0, 15)) console.error(`  ${x.file}${x.line ? `:${x.line}` : ''} — ${x.detail}`);
    if (fresh.length > 15) console.error(`  … and ${fresh.length - 15} more (node scripts/check-glue.mjs --list ${rule})`);
  } else if (fixed) console.log(`${rule}: ${findings[rule].length} (baseline ${allowed.size}) — ${fixed} fixed; run --baseline to drop them`);
  else console.log(`${rule}: ${findings[rule].length}${findings[rule].length ? ' (all baselined — known backlog)' : ''}`);
}
if (failed) { console.error('\ncheck-glue: FAIL — new glue-discipline violations (design 00 §8.3, artifact contract C2). Fix them; never raise the baseline.'); process.exit(1); }
console.log('check-glue: ok (no new violations)');
