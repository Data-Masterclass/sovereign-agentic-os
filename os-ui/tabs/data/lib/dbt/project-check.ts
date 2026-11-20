/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Pre-commit structural check of a generated dbt project — the `dbt parse` refusals
 *             the generator can see coming, each attributed to the OS dataset that caused it
 * USER STORY: As a domain owner I want one dataset with a bad definition to be LEFT OUT of my
 *             domain's dbt project (and told why), never to fail `dbt parse` for the whole project —
 *             because repo-sync keeps Dagster on the last commit that parsed, so one bad dataset
 *             otherwise silently stops every scheduled sync and build in the domain.
 * ARCHITECTURE:
 *   - Pure: `checkProject(files)` reads the path → content map `generateProject` built and returns
 *     issues. It does NOT run dbt (os-ui has no dbt); it checks the parse-time rules dbt enforces
 *     that a generator bug or repeated authored input can break (live incident 2026-11, track H:
 *     a quality rule recorded twice became two identical tests, and dbt 1.9 refused the project
 *     with `dbt found two data_tests with the name "not_null_<model>_<column>"`):
 *       1. every YAML file parses;
 *       2. no two models share a name (dbt: "found two models with the name");
 *       3. no model is documented twice across `schema.yml` files;
 *       4. no source table is declared twice;
 *       5. no column carries the same test twice (same name + same arguments ⇒ same unique id);
 *       6. every `ref('<model>')` / `source('<s>', '<t>')` a model or test uses exists;
 *       7. no two metrics / semantic models share a name;
 *       8. CLOSED JINJA GRAMMAR (literal safety, defence in depth): every Jinja construct in every
 *          file dbt renders is one the generator itself writes — `ref`/`source`/`config`/`this`/
 *          `is_incremental`/the batch-id `var` in model SQL, `env_var` in profiles, the closed
 *          semantic `filter` grammar — and no other ASCII brace exists. Free text is encoded and
 *          identifiers are validated before rendering (`literal.ts`), so this never fires unless a
 *          generator bug lets input through. Issues carry `rule: 'jinja-grammar'`.
 *   - Attribution: a model file's header names its OS dataset (`OS dataset <id>`), a `schema.yml`
 *     entry carries `config.meta.os_dataset`, a source table `meta.os_dataset` or the id in its
 *     description, a semantic file is attributed through the model it is named after. An issue the
 *     check cannot pin on a dataset carries `datasetId: null` (the generator cannot skip it).
 *   - The skip loop lives in `generate.ts`; this file only reports.
 */
import yaml from 'js-yaml';
import { renderGenericTests, renderMacros } from '@tabs/data/lib/dbt/project';
import { isSafeSemanticFilter } from '@tabs/data/lib/dbt/semantic/validate';

export type ProjectIssue = {
  /** The OS dataset whose files caused the issue; null when it cannot be attributed. */
  datasetId: string | null;
  path: string;
  reason: string;
  /** Set for the closed-Jinja-grammar rule, which the generator treats as fail-closed. */
  rule?: 'jinja-grammar';
};

type Plain = Record<string, unknown>;

const DATASET_IN_TEXT = /OS dataset (ds_[A-Za-z0-9_]+)/;
const REF_RE = /\{\{\s*ref\(\s*'([^']+)'\s*\)\s*\}\}/g;
const SOURCE_RE = /\{\{\s*source\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\}\}/g;
const REF_ARG_RE = /^\s*ref\(\s*'([^']+)'\s*\)\s*$/;

function asList(v: unknown): Plain[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Plain[]) : [];
}

function canonical(v: unknown): string {
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as Plain).sort().map((k) => [k, canon((x as Plain)[k])]));
    return x;
  };
  return JSON.stringify(canon(v));
}

function metaDataset(entry: Plain): string | null {
  const config = (entry.config && typeof entry.config === 'object' ? entry.config : {}) as Plain;
  const meta = (config.meta ?? entry.meta) as Plain | undefined;
  const id = meta && typeof meta.os_dataset === 'string' ? meta.os_dataset : null;
  if (id) return id;
  const m = typeof entry.description === 'string' ? DATASET_IN_TEXT.exec(entry.description) : null;
  return m ? m[1] : null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Every structural `dbt parse` refusal visible in `files`, attributed where possible. */
export function checkProject(files: Map<string, string>): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const push = (datasetId: string | null, path: string, reason: string) => issues.push({ datasetId, path, reason });

  // ---- models (.sql under models/) ---------------------------------------------------------
  const modelDataset = new Map<string, string | null>(); // model name → dataset
  const modelPath = new Map<string, string>();
  for (const [path, content] of files) {
    if (!path.startsWith('models/') || !path.endsWith('.sql')) continue;
    const name = basename(path).slice(0, -'.sql'.length);
    const ds = DATASET_IN_TEXT.exec(content)?.[1] ?? null;
    if (modelPath.has(name)) {
      const reason = `two dbt models are named '${name}' (${modelPath.get(name)} and ${path}); dbt refuses duplicate model names`;
      push(ds, path, reason);
      const first = modelDataset.get(name) ?? null;
      if (first && first !== ds) push(first, modelPath.get(name)!, reason);
      continue;
    }
    modelPath.set(name, path);
    modelDataset.set(name, ds);
  }

  // ---- YAML --------------------------------------------------------------------------------
  const sourceTables = new Map<string, string>(); // `<source>.<table>` → path
  const documented = new Map<string, string>(); // model name → path
  const metricNames = new Map<string, string>();
  const semanticNames = new Map<string, string>();
  const testRefs: { ds: string | null; path: string; model: string }[] = [];

  const checkColumns = (entry: Plain, ds: string | null, path: string, owner: string) => {
    for (const col of asList(entry.columns)) {
      const seen = new Set<string>();
      for (const t of Array.isArray(col.data_tests) ? (col.data_tests as unknown[]) : []) {
        const key = canonical(t);
        if (seen.has(key)) {
          const kind = typeof t === 'string' ? t : Object.keys(t as Plain)[0];
          push(ds, path, `column '${String(col.name)}' of '${owner}' carries the same '${kind}' test twice; dbt refuses two tests with the same name`);
        }
        seen.add(key);
        if (t && typeof t === 'object') {
          const rel = (t as Plain).relationships as Plain | undefined;
          const m = rel && typeof rel.to === 'string' ? REF_ARG_RE.exec(rel.to) : null;
          if (m) testRefs.push({ ds, path, model: m[1] });
        }
      }
    }
  };

  for (const [path, content] of files) {
    if (!path.endsWith('.yml') || !path.startsWith('models/')) continue;
    let doc: Plain;
    try {
      doc = (yaml.load(content) ?? {}) as Plain;
    } catch (e) {
      push(null, path, `not valid YAML: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    for (const m of asList(doc.models)) {
      const name = String(m.name ?? '');
      const ds = metaDataset(m) ?? modelDataset.get(name) ?? null;
      if (documented.has(name)) push(ds, path, `model '${name}' is documented twice (${documented.get(name)} and ${path})`);
      else documented.set(name, path);
      checkColumns(m, ds, path, name);
    }
    for (const s of asList(doc.sources)) {
      for (const t of asList(s.tables)) {
        const key = `${String(s.name)}.${String(t.name)}`;
        const ds = metaDataset(t);
        if (sourceTables.has(key)) push(ds, path, `source table '${key}' is declared twice`);
        else sourceTables.set(key, path);
        checkColumns(t, ds, path, key);
      }
    }
    // Semantic files are named after the model they describe: models/**/semantic/<model>.yml.
    const semanticDs = path.includes('/semantic/') ? (modelDataset.get(basename(path).slice(0, -'.yml'.length)) ?? null) : null;
    for (const sm of asList(doc.semantic_models)) {
      const name = String(sm.name ?? '');
      if (semanticNames.has(name)) push(semanticDs, path, `semantic model '${name}' is defined twice (${semanticNames.get(name)} and ${path})`);
      else semanticNames.set(name, path);
    }
    for (const mt of asList(doc.metrics)) {
      const name = String(mt.name ?? '');
      if (metricNames.has(name)) push(semanticDs, path, `metric '${name}' is defined twice (${metricNames.get(name)} and ${path})`);
      else metricNames.set(name, path);
    }
  }

  // ---- references --------------------------------------------------------------------------
  for (const [path, content] of files) {
    if (!path.startsWith('models/') || !path.endsWith('.sql')) continue;
    const ds = DATASET_IN_TEXT.exec(content)?.[1] ?? null;
    for (const m of content.matchAll(REF_RE)) {
      if (!modelPath.has(m[1])) push(ds, path, `ref('${m[1]}') names a model that is not in the project`);
    }
    for (const m of content.matchAll(SOURCE_RE)) {
      if (!sourceTables.has(`${m[1]}.${m[2]}`)) push(ds, path, `source('${m[1]}', '${m[2]}') is not declared in models/sources.yml`);
    }
  }
  for (const r of testRefs) {
    if (!modelPath.has(r.model)) push(r.ds, r.path, `a relationships test points at ref('${r.model}'), which is not in the project`);
  }
  for (const i of jinjaGrammarIssues(files)) issues.push(i);
  return issues;
}

// ---- rule 8: closed Jinja grammar --------------------------------------------------------------

const ID = "[A-Za-z_][A-Za-z0-9_]*";
/** Every Jinja construct the generator writes into a model `.sql` file — nothing else. */
const SQL_JINJA: RegExp[] = [
  new RegExp(`^\\{\\{ ref\\('${ID}'\\) \\}\\}`),
  new RegExp(`^\\{\\{ source\\('${ID}', '${ID}'\\) \\}\\}`),
  /^\{\{ this \}\}/,
  /^\{% if is_incremental\(\) %\}/,
  /^\{% endif %\}/,
  /^\{\{ var\("os_batch_id", invocation_id\) \}\}/,
  new RegExp(`^\\{\\{ config\\((?:${ID}=(?:'[A-Za-z0-9_+]*'|\\[(?:'${ID}'(?:, '${ID}')*)?\\])(?:, )?)+\\) \\}\\}`),
];
/** The only Jinja allowed in a YAML string value outside a semantic `filter`. */
const YAML_JINJA = /^\{\{ env_var\('[A-Z][A-Z0-9_]*'(?:, '[A-Za-z0-9_.-]*')?\)(?: \| as_number)? \}\}$/;

function sqlJinjaFindings(content: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '{') {
      const rest = content.slice(i);
      const m = SQL_JINJA.map((re) => re.exec(rest)).find(Boolean);
      if (m) {
        i += m[0].length;
        continue;
      }
      out.push(rest.slice(0, 40));
    } else if (ch === '}') {
      out.push(content.slice(Math.max(0, i - 20), i + 1));
    }
    i += 1;
  }
  return out;
}

function yamlJinjaFindings(node: unknown, key: string | null, out: string[]): void {
  if (typeof node === 'string') {
    if (!/[{}]/.test(node)) return;
    if (key === 'filter' && isSafeSemanticFilter(node)) return;
    if (YAML_JINJA.test(node)) return;
    out.push(node.slice(0, 60));
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) yamlJinjaFindings(v, key, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Plain)) {
      if (/[{}]/.test(k)) out.push(k.slice(0, 60));
      yamlJinjaFindings(v, k, out);
    }
  }
}

/** Rule 8 on its own (exported for the literal-safety fuzz suite). */
export function jinjaGrammarIssues(files: Map<string, string>): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const fixed = new Map([...renderMacros(), ...renderGenericTests()]);
  for (const [path, content] of files) {
    // Generator-owned constant files (macros, generic tests) are exempt only while byte-identical.
    if (fixed.has(path) && fixed.get(path) === content) continue;
    const ds = DATASET_IN_TEXT.exec(content)?.[1] ?? null;
    let findings: string[] = [];
    if (path.endsWith('.sql')) findings = sqlJinjaFindings(content);
    else if (path.endsWith('.yml') || path.endsWith('.yaml')) {
      let doc: unknown;
      try {
        doc = yaml.load(content);
      } catch {
        continue; // rule 1 reports it
      }
      yamlJinjaFindings(doc, null, findings);
    } else if (/[{}]/.test(content)) findings = [content.slice(content.search(/[{}]/), content.search(/[{}]/) + 40)];
    for (const f of findings) {
      issues.push({ datasetId: path.endsWith('.sql') ? ds : yamlDataset(content, path, f), path, reason: `Jinja outside the generator's grammar: ${JSON.stringify(f)}`, rule: 'jinja-grammar' });
    }
  }
  return issues;
}

/** The dataset a YAML finding belongs to: the `os_dataset` / `OS dataset <id>` nearest above it. */
function yamlDataset(content: string, _path: string, finding: string): string | null {
  // A generated description names its dataset FIRST (`… OS dataset <id> ("<name>")`), before any
  // authored text, so the first id in the finding is the generator's own.
  const own = DATASET_IN_TEXT.exec(finding)?.[1];
  if (own) return own;
  const at = content.indexOf(finding.slice(0, 20));
  const before = at >= 0 ? content.slice(0, at) : content;
  const ids = [...before.matchAll(/(?:os_dataset: |OS dataset |dataset: )(ds_[A-Za-z0-9_]+)/g)];
  return ids.length ? ids[ids.length - 1][1] : null;
}
