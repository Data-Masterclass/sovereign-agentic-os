/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    GLUE-10 — artifact contract C2 (component-design 11 §4.1): in generated native
 *             files, OS metadata may appear only in the tool's documented extension points; and
 *             C3's static half: no silver/gold layer is a dbt source built outside dbt (WP-49).
 * USER STORY: As the owner I want every artifact the OS writes to be the tool's own code that runs
 *             without the OS: OS bookkeeping lives in dbt `meta`/`tags`, Dagster `tags`/`metadata`,
 *             OKF `x-sovereign-os-meta`, `sovereign-os.io/*` Kubernetes labels and annotations, or
 *             in the OS's own files, never mixed into native code anywhere else.
 * ARCHITECTURE:
 *   - Each native file is parsed with its tool's grammar or schema, never grepped:
 *       dbt YAML        → js-yaml + dbt-jsonschema (ajv); an unknown key (`additionalProperties`)
 *                         outside an extension point is a finding;
 *       Vega-Lite JSON  → the Vega-Lite v5 schema (ajv);
 *       Kubernetes YAML → OS keys only as `sovereign-os.io/*` labels/annotations;
 *       Python          → Python's `ast` (scripts/glue/py_kwargs.py): OS kwargs only in tags=/metadata=;
 *       SQL             → comments (the 00 §4 header) stripped and the `config(meta=…)` argument
 *                         span removed; any remaining OS identifier, or Jinja reading `meta`, is a finding;
 *       .mjs/.js        → TypeScript AST: no OS-named object keys;
 *       .json / .md     → OS keys only under `x-sovereign-os-meta` (Markdown: its YAML frontmatter).
 *     On top of the schema, every parsed document is walked for OS-named keys (`os`, `os_*`, `os-*`,
 *     `os/*`, `osCamel`, `x-os-*`, `sovereign*`) outside the extension points.
 *   - OS-layer files (11 §4.2: `os/` data files, `<dir>/os.yaml`, `<dir>/system.yaml`, `agents/index.yml`,
 *     `apps/<slug>/app.yaml`) are the OS's own files and are skipped — but an EXECUTABLE native type under
 *     `os/` (.py .sql .mjs .js .ts .rego .sh) is itself a finding.
 *   - Schemas are vendored and pinned in scripts/glue/schemas/ (UPSTREAM.md: source, version, sha256,
 *     licence); a schema gap that dbt itself documents is patched in SCHEMA_ADDITIONS with its URL.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseTs, walk, ts } from './ast.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = resolve(HERE, '..', '..', 'os-ui');
const req = createRequire(join(TOOLS, 'package.json'));
const yaml = req('js-yaml');
const AjvMod = req('ajv');
const Ajv = AjvMod.default ?? AjvMod;

const SCHEMA_SHA256 = {
  'dbt_yml_files.json': '80b04ecc7dfb06eab4c5f18b9148293fc75575bffb0747553f0bc01865e040ba',
  'dbt_project.json': 'a27ea5930dd964190ac0b4f9e70cc56aadd0c0eee70759ef340cf1a9c833eba2',
  'vega-lite-v5.json': '1aeeda8aa44dcce60f6b6fb7d8b650487e3e389a8284a2040e590be9a4c7610e',
};
const loadSchema = (name) => {
  const raw = name.endsWith('.json') && name.startsWith('vega') ? gunzipSync(readFileSync(join(HERE, 'schemas', name + '.gz'))) : readFileSync(join(HERE, 'schemas', name));
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== SCHEMA_SHA256[name]) throw new Error(`schema ${name} does not match its pinned sha256 (scripts/glue/schemas/UPSTREAM.md)`);
  return JSON.parse(raw.toString('utf8'));
};

// dbt documents `config` (meta, enabled, group, tags) on metrics; dbt-jsonschema @6a401244 lacks it.
// https://docs.getdbt.com/reference/resource-properties/config (metrics) — keep this list minimal.
const SCHEMA_ADDITIONS = (dbtYml) => {
  const it = dbtYml.properties?.metrics?.items;
  if (it?.properties) {
    it.properties.config = { type: 'object', properties: { meta: { type: 'object' }, enabled: { type: 'boolean' }, group: { type: 'string' }, tags: {} }, additionalProperties: false };
    it.properties.meta = { type: 'object' };
  }
  return dbtYml;
};

let ajv, vDbtYml, vDbtProject, vVegaLite;
const validators = () => {
  if (!ajv) {
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    vDbtYml = ajv.compile(SCHEMA_ADDITIONS(loadSchema('dbt_yml_files.json')));
    vDbtProject = ajv.compile(loadSchema('dbt_project.json'));
  }
  return { vDbtYml, vDbtProject };
};
const vegaLite = () => { validators(); return (vVegaLite ??= ajv.compile(loadSchema('vega-lite-v5.json'))); };

// `sovereign` alone is the dbt profile NAME (profiles.yml / dbt_project.yml `profile:`), not metadata.
// dbt's `+` config prefix (`+os_owner` under dbt_project.yml `models:`) is stripped first.
export const OS_KEY = (key) => { const k = String(key).replace(/^\+/, ''); return /^(os($|[_\-/.:])|x[-_]os[-_]|x[-_]sovereign|sovereign[-_]os)/i.test(k) || /^os[A-Z]/.test(k); };
const OS_LAYER_FILE = (p) => /^os\/.+\.(ya?ml|json|md|txt)$/.test(p) || /(^|\/)(os|system)\.ya?ml$/.test(p) || p === 'agents/index.yml' || /^apps\/[^/]+\/app\.ya?ml$/.test(p);
const EXECUTABLE_UNDER_OS = (p) => /^os\/.+\.(py|sql|mjs|cjs|js|ts|rego|sh)$/.test(p);
const DBT_YML = (p) => /^(models|macros|tests|seeds|snapshots|analyses|semantic_models|metrics)\/.+\.ya?ml$/.test(p);

/** Walk a parsed YAML/JSON document for OS-named keys outside `allowed(pathOfParentKeys)`. */
function osKeys(doc, allowed, hit, path = []) {
  if (Array.isArray(doc)) return doc.forEach((v, i) => osKeys(v, allowed, hit, [...path, i]));
  if (!doc || typeof doc !== 'object') return;
  for (const [k, v] of Object.entries(doc)) {
    const here = [...path, k];
    if (allowed(here)) continue;
    if (OS_KEY(k)) hit(`OS key \`${here.join('.')}\` outside the tool's extension points`);
    osKeys(v, allowed, hit, here);
  }
}
const DBT_EXT = (path) => path.some((s) => s === 'meta' || s === '+meta' || s === 'tags' || s === '+tags');
const OKF_EXT = (path) => path.includes('x-sovereign-os-meta');
const NONE = () => false;

/** Definitive unknown keys from an ajv run: `additionalProperties` not inside a oneOf/anyOf branch. */
function unknownKeys(validate, doc, hit, ext) {
  if (validate(doc)) return;
  const seen = new Set();
  for (const e of validate.errors ?? []) {
    if (e.keyword !== 'additionalProperties' || /\/(oneOf|anyOf|allOf|if|then|else|not)\//.test(e.schemaPath)) continue;
    const path = [...e.instancePath.split('/').filter(Boolean), e.params.additionalProperty];
    if (ext(path)) continue;
    const key = path.join('.');
    if (!seen.has(key)) { seen.add(key); hit(`unknown key \`${key}\` (not in the tool's schema)`); }
  }
}

/**
 * C3 — dbt can rebuild every layer (WP-49): a dataset's silver or gold layer is a dbt MODEL, never a
 * dbt `source` that a table built outside dbt is read through. The OS's own marks on a source
 * (`meta.os_layer` silver/gold, `meta.os_built`) are what identify such a layer.
 */
function rebuildable(doc, hit) {
  for (const src of Array.isArray(doc?.sources) ? doc.sources : []) {
    for (const t of Array.isArray(src?.tables) ? src.tables : []) {
      const meta = { ...(src?.meta ?? {}), ...(t?.meta ?? {}), ...(t?.config?.meta ?? {}) };
      const layer = String(meta.os_layer ?? '');
      if (meta.os_built || layer === 'silver' || layer === 'gold') {
        hit(`dbt cannot rebuild \`${src.name}.${t.name}\`: a ${layer || 'dataset'} layer emitted as a dbt source built outside dbt (C3 — every silver and gold layer is a dbt model)`);
      }
    }
  }
}

function sqlFindings(text, hit) {
  let s = text.replace(/\{#[\s\S]*?#\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  // Remove ONLY the `meta=` argument of a `config(...)` call: dbt's documented extension point.
  const close = (str, i, open, shut) => { let d = 0; for (let j = i; j < str.length; j++) { if (str[j] === open) d++; else if (str[j] === shut && --d === 0) return j; } return str.length - 1; };
  for (const m of [...s.matchAll(/\bconfig\s*\(/g)]) {
    const start = m.index + m[0].length - 1, end = close(s, start, '(', ')');
    const inner = s.slice(start, end);
    const mm = inner.match(/\bmeta\s*=\s*\{/);
    if (!mm) continue;
    const at = start + mm.index, brace = at + mm[0].length - 1, stop = close(s, brace, '{', '}');
    s = s.slice(0, at) + s.slice(at, stop + 1).replace(/[^\n]/g, ' ') + s.slice(stop + 1);
  }
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    // Identity/governance names only: a dbt `var('os_batch_id')` is dbt's own parameter mechanism
    // (`dbt build --vars`), runnable without the OS; `var('os_principal')` makes SQL depend on who the OS says runs it.
    const os = line.match(/\bos_(dataset|domain|principal|uid|scope|owner|user|built|tier|layer|id|member|metric|agg)\b|\bOS (dataset|domain|principal|uid|scope|owner)\b|\bvar\(\s*['"]os_(principal|uid|owner|domain|scope|user|dataset)\b|\benv_var\(\s*['"]OS_(PRINCIPAL|UID|OWNER|DOMAIN|SCOPE|USER)\b/i);
    if (os) hit(`OS identifier \`${os[0]}\` in native SQL`, i + 1);
    const meta = line.match(/\.meta\b|\bmeta\s*\[|\bconfig\.get\(\s*['"]meta['"]/);
    if (meta) hit(`native SQL reads dbt meta (\`${meta[0]}\`) — behaviour must not depend on OS metadata`, i + 1);
  });
}

// A native module imports its tool's packages, Node built-ins and its own relative files — never the
// OS (`@core/…`, `@tabs/…`, `@/…`, `@sovereign-os/…`). artifact contract 11 §4.1 C1 fixture: "a
// graph.mjs importing @core/…". A generated graph.mjs also never reads the environment (WP-53).
const OS_IMPORT = (spec) => /^@(core|tabs|app|lib|components|sovereign-os)\//.test(spec) || spec.startsWith('@/');
function mjsFindings(path, text, hit) {
  const f = parseTs(path.replace(/\.(mjs|cjs|js)$/, '.ts'), text);
  const lineOf = (n) => f.sf.getLineAndCharacterOfPosition(n.getStart(f.sf)).line + 1;
  walk(f, (n) => {
    const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
      ? n.moduleSpecifier.text
      : ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])
        ? n.arguments[0].text
        : null;
    if (spec !== null && OS_IMPORT(spec)) hit(`OS import \`${spec}\` in native JS`, lineOf(n));
    if (/(^|\/)graph\.mjs$/.test(path) && ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'process' && n.name.text === 'env') {
      hit('`process.env` read in a generated graph.mjs (the module takes its inputs from buildGraph)', lineOf(n));
    }
  });
  walk(f, (n) => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && OS_KEY(n.name.text)) {
      hit(`OS key \`${n.name.text}\` in native JS`, f.sf.getLineAndCharacterOfPosition(n.getStart(f.sf)).line + 1);
    }
  });
}

/**
 * @param goldens [{ id, files: {path: content} }]
 * @returns findings [{ file, line, key, detail }]
 */
export function checkContract(goldens) {
  const out = [];
  const py = [];
  for (const g of goldens) {
    for (const [p, content] of Object.entries(g.files)) {
      if (typeof content !== 'string') continue;
      const file = `${g.id}#${p}`;
      const hit = (detail, line = 0) => out.push({ file, line, key: detail, detail });
      if (EXECUTABLE_UNDER_OS(p)) { hit('executable native code under the OS-layer `os/` directory'); continue; }
      if (OS_LAYER_FILE(p)) continue;
      try {
        if (/\.ya?ml$/.test(p)) {
          const docs = yaml.loadAll(content);
          for (const doc of docs) {
            if (!doc || typeof doc !== 'object') continue;
            if (typeof doc.apiVersion === 'string' && typeof doc.kind === 'string') {
              osKeys(doc, (path) => path[0] === 'metadata' && (path[1] === 'labels' || path[1] === 'annotations') && path.length === 3 && String(path[2]).startsWith('sovereign-os.io/'), hit);
            } else if (p === 'dbt_project.yml') {
              unknownKeys(validators().vDbtProject, doc, hit, DBT_EXT); osKeys(doc, DBT_EXT, hit);
            } else if (DBT_YML(p)) {
              unknownKeys(validators().vDbtYml, doc, hit, DBT_EXT); osKeys(doc, DBT_EXT, hit); rebuildable(doc, hit);
            } else {
              osKeys(doc, DBT_EXT, hit); // profiles.yml, packages.yml, selectors.yml: dbt files without a pinned schema here
            }
          }
        } else if (/\.json$/.test(p)) {
          const doc = JSON.parse(content);
          if (/\.vl\.json$/.test(p) || /vega-lite/.test(String(doc?.$schema ?? ''))) {
            unknownKeys(vegaLite(), doc, hit, NONE); osKeys(doc, NONE, hit);
          } else osKeys(doc, OKF_EXT, hit);
        } else if (/\.md$/.test(p)) {
          const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (fm) osKeys(yaml.load(fm[1]), OKF_EXT, hit);
        } else if (/\.sql$/.test(p)) sqlFindings(content, hit);
        else if (/\.py$/.test(p)) py.push({ path: file, source: content });
        else if (/\.(mjs|cjs|js)$/.test(p)) mjsFindings(p, content, hit);
      } catch (e) {
        hit(`does not parse: ${String(e.message).split('\n')[0]}`);
      }
    }
  }
  if (py.length) {
    const r = spawnSync('python3', ['-I', join(HERE, 'py_kwargs.py')], { input: JSON.stringify(py), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`python3 is required for GLUE-10 (generated Python): ${r.error?.message ?? r.stderr}`);
    for (const f of JSON.parse(r.stdout)) out.push({ file: f.path, line: f.line, key: f.detail, detail: f.detail });
  }
  return out;
}
