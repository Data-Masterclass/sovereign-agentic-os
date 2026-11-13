/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    dbt models + `schema.yml` pushed by an engineer → dataset records in the registry
 * USER STORY: As a data engineer I want to add a model and its `schema.yml` in VS Code, `git push`,
 *             and find the dataset in the OS with its layer, schema, columns, description and the
 *             quality rules I wrote as dbt tests — the same state the UI would have produced
 *             (E-R4.4, checklist E9).
 * ARCHITECTURE:
 *   - The Data half of the `ingestFromRepo(kind, files)` contract, REGISTERED with
 *     `core/infra/git-receive.ts` so the gate never imports a tab (check-structure rule 3).
 *   - TWO LAYERS, deliberately. `readSchemaYml` / `datasetsFromSchemaYml` are PURE: bytes in,
 *     `IngestedModel[]` out, with no store, no cluster and no identity — that is where every
 *     reverse-mapping test lives. `ingestDbtModels` then applies them through the GOVERNED
 *     services (`createDatasetService`, `defineQualityRulesService`, and the docs chokepoint
 *     `setDocs` the docs route itself calls), inside `runWithSurface('git:push')`.
 *   - It is the EXACT inverse of `tabs/data/lib/dbt/schema.ts`: `config.meta.os_dataset` is the
 *     identity the OS wrote, so a round trip through a push changes nothing. A model with NO
 *     `os_dataset` is a dataset an engineer created in the repo, and it is created in the OS.
 *   - WHAT IT WILL NOT GUESS: a `relationships` test maps to a `reference` rule only when the
 *     referenced dataset can be resolved from this push; otherwise it is reported as a note, never
 *     as a rule against a guessed id. A rule already on the dataset is not added twice.
 *   - It never writes a layer VERSION: whether a layer is physically built is the build path's
 *     fact, and a push is not a build. The push updates the definition; Dagster materialises it
 *     from the same commit (the existing reload hook).
 */
import 'server-only';
import { load } from 'js-yaml';
import { registerRepoKind, type ChangedFile, type IngestReport, type Pusher } from '@core/infra/git-receive';
import { runWithSurface } from '@core/infra/request-surface';
import { createDatasetService, defineQualityRulesService, type QualityRuleInput } from '@tabs/data/lib/mutations-server';
import { getDataset, setDocs, type Principal } from '@tabs/data/lib/store';
import { SAFE_COLUMN } from '@tabs/data/lib/dbt/schema';
import { sanitizeIdent } from '@tabs/data/lib/store-fqn';
import type { Layer } from '@tabs/data/lib/dataset-schema';

/** The `ingestFromRepo` key for this kind. */
export const DATASET_KIND = 'dataset';

/** `models/**\/schema.yml` — the file that carries the documentation and the tests. */
export const SCHEMA_YML_RE = /^models\/(?:[^/]+\/)*schema\.yml$/;

/** A model's SQL. Changed on its own it is a build input, not a registry fact. */
export const MODEL_SQL_RE = /^models\/(?:[^/]+\/)*[^/]+\.sql$/;

export function matchesDbt(filePath: string): boolean {
  return SCHEMA_YML_RE.test(filePath) || MODEL_SQL_RE.test(filePath);
}

export type IngestedColumn = { name: string; description: string };

export type IngestedModel = {
  /** The dbt model name — `silver_orders`. */
  model: string;
  /** The OS dataset this model belongs to, when the file says so (`config.meta.os_dataset`). */
  datasetId: string | null;
  /** The display name for a dataset that has to be created. */
  name: string;
  layer: Layer;
  /** The Trino/Iceberg schema the model materialises into. */
  schema: string;
  description: string;
  columns: IngestedColumn[];
  rules: QualityRuleInput[];
  /** Everything the file asked for that could NOT be mapped, in words. */
  notes: string[];
};

const LAYERS: readonly Layer[] = ['bronze', 'silver', 'gold'];

/**
 * The layer a model belongs to: `config.meta.os_layer` when the OS wrote the file, else the
 * directory (`models/silver/…`), else the model-name prefix an engineer in a personal lane uses
 * (`silver_orders`). `bronze` is the honest default — it is the entry point.
 */
export function layerOf(filePath: string, modelName: string, meta: Record<string, unknown>): Layer {
  const declared = String(meta.os_layer ?? '');
  if ((LAYERS as readonly string[]).includes(declared)) return declared as Layer;
  const dir = filePath.split('/').slice(0, -1);
  const fromDir = dir.find((seg) => (LAYERS as readonly string[]).includes(seg));
  if (fromDir) return fromDir as Layer;
  const prefix = modelName.split('_')[0];
  if ((LAYERS as readonly string[]).includes(prefix)) return prefix as Layer;
  return 'bronze';
}

/** `models/personal/<uid>/…` → `personal_<uid>`; anything else → the domain's schema. */
export function schemaOf(filePath: string, domain: string): string {
  const parts = filePath.split('/');
  if (parts[1] === 'personal' && parts[2]) return `personal_${sanitizeIdent(parts[2])}`;
  return sanitizeIdent(domain);
}

type RawModel = {
  name?: unknown;
  description?: unknown;
  config?: { meta?: unknown } | unknown;
  columns?: unknown;
};

/** Parse `schema.yml`. Returns the raw model list, or a message naming what is wrong. */
export function readSchemaYml(content: string): { models: RawModel[] } | { error: string } {
  let doc: unknown;
  try {
    doc = load(content);
  } catch (e) {
    return { error: `is not valid YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` };
  }
  if (!doc || typeof doc !== 'object') return { error: 'is empty — a dbt schema file needs `version: 2` and `models:`' };
  const d = doc as { version?: unknown; models?: unknown; sources?: unknown };
  if (d.version !== 2) return { error: 'must declare `version: 2` (dbt refuses any other value here)' };
  if (d.models === undefined && d.sources !== undefined) return { models: [] }; // a sources-only file is valid dbt
  if (!Array.isArray(d.models)) return { error: '`models:` must be a list' };
  return { models: d.models as RawModel[] };
}

/**
 * The SAME gate the UI's write path applies — `readSchemaYml` plus the one invariant that makes a
 * dbt project parseable at all: every model has a plain-identifier name, and so does every column.
 * A name dbt cannot resolve takes the WHOLE domain's project down at `dbt parse`, not just one
 * model, which is why it is refused at the door rather than discovered by Dagster.
 */
export function validateDbtFile(file: { path: string; content: string }): string | null {
  if (MODEL_SQL_RE.test(file.path) && !SCHEMA_YML_RE.test(file.path)) {
    const name = (file.path.split('/').pop() ?? '').replace(/\.sql$/, '');
    if (!SAFE_COLUMN.test(name)) return `'${name}' is not a usable dbt model name (letters, digits and _, not starting with a digit)`;
    if (!file.content.trim()) return 'is empty — dbt cannot build a model with no SQL';
    return null;
  }
  const parsed = readSchemaYml(file.content);
  if ('error' in parsed) return parsed.error;
  for (const raw of parsed.models) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!name) return 'has a model entry with no `name`';
    if (!SAFE_COLUMN.test(name)) return `model name '${name}' is not a usable dbt identifier`;
    const columns = Array.isArray(raw?.columns) ? (raw.columns as { name?: unknown }[]) : [];
    for (const c of columns) {
      const cn = typeof c?.name === 'string' ? c.name.trim() : '';
      if (!cn) return `model '${name}' has a column with no \`name\``;
      if (!SAFE_COLUMN.test(cn)) return `column '${cn}' of model '${name}' is not a usable dbt identifier`;
    }
  }
  return null;
}

/** One dbt `data_tests` entry → a quality rule, or null with the reason it could not be one. */
export function testToRule(column: string, spec: unknown): { rule: QualityRuleInput } | { skip: string } {
  if (typeof spec === 'string') {
    if (spec === 'not_null' || spec === 'unique' || spec === 'not_blank') {
      return { rule: { rule: spec, column, name: `${spec}(${column})` } };
    }
    return { skip: `test '${spec}' on ${column} has no OS rule — it stays a dbt test only` };
  }
  if (!spec || typeof spec !== 'object') return { skip: `an unreadable test on ${column}` };
  const [key, args] = Object.entries(spec as Record<string, unknown>)[0] ?? [];
  if (key === 'accepted_values') {
    const values = (args as { values?: unknown })?.values;
    if (!Array.isArray(values) || values.length === 0) return { skip: `accepted_values on ${column} lists no values` };
    return { rule: { rule: 'accepted_values', column, values: values.map((v) => String(v)), name: `accepted_values(${column})` } };
  }
  if (key === 'range') {
    const a = (args ?? {}) as { min?: unknown; max?: unknown };
    const min = typeof a.min === 'number' ? a.min : undefined;
    const max = typeof a.max === 'number' ? a.max : undefined;
    if (min === undefined && max === undefined) return { skip: `range on ${column} has neither min nor max` };
    return { rule: { rule: 'range', column, min, max, name: `range(${column})` } };
  }
  if (key === 'relationships') {
    // `to: ref('<model>')` names a MODEL; an OS `reference` rule needs a DATASET id. Resolving one
    // from the other needs the whole project, so this is reported, never guessed (see the header).
    return { skip: `relationships on ${column} needs the referenced dataset — add it in the OS` };
  }
  return { skip: `test '${key}' on ${column} has no OS rule — it stays a dbt test only` };
}

/** PURE: `schema.yml` bytes → what the registry should hold. The reverse of `dbt/schema.ts`. */
export function datasetsFromSchemaYml(filePath: string, content: string, domain: string): IngestedModel[] {
  const parsed = readSchemaYml(content);
  if ('error' in parsed) return [];
  const out: IngestedModel[] = [];
  for (const raw of parsed.models) {
    const model = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!model) continue;
    const meta = (((raw as { config?: { meta?: unknown } }).config?.meta ?? {}) as Record<string, unknown>) || {};
    const notes: string[] = [];
    const columns: IngestedColumn[] = [];
    const rules: QualityRuleInput[] = [];
    const rawColumns = Array.isArray(raw?.columns) ? (raw.columns as Record<string, unknown>[]) : [];
    for (const c of rawColumns) {
      const name = typeof c?.name === 'string' ? c.name.trim() : '';
      if (!name) continue;
      columns.push({ name, description: typeof c.description === 'string' ? c.description : '' });
      const tests = c.data_tests ?? c.tests; // `tests:` is the pre-1.8 spelling; accept both on read
      for (const spec of Array.isArray(tests) ? tests : []) {
        const mapped = testToRule(name, spec);
        if ('rule' in mapped) rules.push(mapped.rule);
        else notes.push(mapped.skip);
      }
    }
    for (const intention of Array.isArray(meta.os_intentions) ? (meta.os_intentions as unknown[]) : []) {
      rules.push({ name: String(intention), description: '' });
    }
    out.push({
      model,
      datasetId: typeof meta.os_dataset === 'string' && meta.os_dataset ? meta.os_dataset : null,
      // The OS writes `<layer> layer of OS dataset <id> ("<name>"). <description>`; an engineer's
      // own file has whatever they wrote. Either way the DISPLAY name defaults to the model name —
      // never a scraped fragment of a sentence.
      name: model,
      layer: layerOf(filePath, model, meta),
      schema: schemaOf(filePath, domain),
      description: typeof raw.description === 'string' ? raw.description : '',
      columns,
      rules,
      notes,
    });
  }
  return out;
}

function sameRule(a: QualityRuleInput, b: { rule?: string; column?: string; values?: string[]; min?: number; max?: number; name?: string }): boolean {
  if (!a.rule) return !b.rule && String(a.name ?? '') === String(b.name ?? '');
  return (
    a.rule === b.rule &&
    String(a.column ?? '') === String(b.column ?? '') &&
    JSON.stringify(a.values ?? null) === JSON.stringify(b.values ?? null) &&
    (a.min ?? null) === (b.min ?? null) &&
    (a.max ?? null) === (b.max ?? null)
  );
}

/** Apply the pushed dbt files through the governed data services, as the pusher. */
export async function ingestDbtModels(input: {
  domain: string;
  files: ChangedFile[];
  pusher: Pusher;
  sha: string;
}): Promise<IngestReport> {
  const { domain, files, pusher } = input;
  const report: IngestReport = { kind: DATASET_KIND, created: 0, updated: 0, skipped: 0, notes: [] };
  const principal: Principal = { id: pusher.id, domains: pusher.domains, role: pusher.role };

  for (const file of files) {
    if (!SCHEMA_YML_RE.test(file.path)) continue; // a .sql change alone is a build input
    if (file.status === 'deleted' || file.content === null) {
      report.skipped += 1;
      report.notes.push(`${file.path} was removed; retire the dataset in the OS to delete it`);
      continue;
    }
    for (const m of datasetsFromSchemaYml(file.path, file.content, domain)) {
      report.notes.push(...m.notes.map((n) => `${file.path}: ${n}`));
      try {
        runWithSurface('git:push', () => {
          let datasetId = m.datasetId;
          if (datasetId) {
            // Throws 404/403 when the id names nothing this pusher may edit — the same guard the
            // UI route gets, so a crafted `os_dataset` cannot reach a foreign dataset.
            getDataset(datasetId, principal);
            setDocs(datasetId, principal, { description: m.description, columns: m.columns });
            report.updated += 1;
          } else {
            const created = createDatasetService(principal, { name: m.name, domain, columns: m.columns });
            datasetId = created.id;
            if (m.description) setDocs(datasetId, principal, { description: m.description, columns: m.columns });
            report.created += 1;
          }
          const current = getDataset(datasetId, principal);
          const fresh = m.rules.filter((r) => !(current.checks ?? []).some((c) => sameRule(r, c)));
          if (fresh.length) defineQualityRulesService(principal, datasetId, fresh);
        });
      } catch (e) {
        report.skipped += 1;
        report.notes.push(`${file.path} (${m.model}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return report;
}

/** Register this kind with the receive gate. Idempotent; called from the boot step. */
export function registerDbtIngest(): void {
  registerRepoKind({
    kind: DATASET_KIND,
    matches: matchesDbt,
    validate: validateDbtFile,
    ingest: ingestDbtModels,
  });
}
