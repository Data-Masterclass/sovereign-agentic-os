/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listDatasets, getDataset, builtLayerFqn, type DatasetSummary, type Principal } from '@/lib/data/store';
import { LAYERS } from '@/lib/data/dataset-schema';
import { parseDescribe, previewSql, type ProfileColumn } from '@/lib/data/profile';
import { slug } from '@/lib/data/store-fqn';
import { queryRun } from '@/lib/infra/governed';

/**
 * GROUNDING for the Science assistant. Everything the Design chat may name — a dataset, a
 * target column, a feature — is resolved HERE against the caller's REAL, DLS-scoped feed, so a
 * suggestion can never reference a dataset the user can't see or a column that doesn't exist. A
 * hallucinated dataset/column is refused WITH A REASON before the Apply card is allowed to
 * render (the route drops the definition when validation fails). Nothing is fabricated.
 */

export type VisibleDataset = { id: string; name: string; fqn: string; scope: 'personal' | 'domain' };

/** The FQN a training job receives for a dataset: `<domain>.<slug(name)>` (mirrors the UI). */
function datasetFqn(d: DatasetSummary): string {
  return `${d.domain}.${slug(d.name)}`;
}

/**
 * The datasets the caller can actually see (mine + domain + marketplace), each with its id,
 * display name and the FQN create stores. This is the SAME governed feed the Data tab lists.
 */
export function visibleDatasets(user: Principal): VisibleDataset[] {
  const g = listDatasets(user);
  const out: VisibleDataset[] = [];
  for (const d of g.mine) out.push({ id: d.id, name: d.name, fqn: datasetFqn(d), scope: 'personal' });
  for (const d of [...g.domain, ...g.marketplace]) out.push({ id: d.id, name: d.name, fqn: datasetFqn(d), scope: 'domain' });
  return out;
}

/** Resolve a dataset's furthest-built layer FQN + the principal to read AS (or null). */
function resolveBuiltTarget(id: string, user: Principal): { fqn: string; principal: string } | null {
  let dataset;
  try {
    dataset = getDataset(id, user); // throws / 403 for a non-viewer
  } catch {
    return null;
  }
  const built = LAYERS.filter((l) => dataset.versions[l].built);
  const layer = built[built.length - 1];
  if (!layer) return null;
  const resolved = builtLayerFqn(dataset, user, layer);
  const fqn = resolved?.fqn ?? '';
  if (!fqn) return null;
  return { fqn, principal: resolved?.principal ?? (user.domains[0] ?? user.id) };
}

/**
 * The REAL columns (name + Trino type) of a dataset's furthest-built layer, read AS the caller
 * through the governed query path (so column masks / view rights apply). Returns [] when the
 * dataset isn't visible or has nothing queryable yet — the assistant is then told there are no
 * columns to reference for it.
 */
export async function datasetColumnsTyped(id: string, user: Principal): Promise<ProfileColumn[]> {
  const target = resolveBuiltTarget(id, user);
  if (!target) return [];
  try {
    const describe = await queryRun(`describe ${target.fqn}`, target.principal);
    return parseDescribe(describe);
  } catch {
    return [];
  }
}

/** The REAL column names of a dataset (thin wrapper over {@link datasetColumnsTyped}). */
export async function datasetColumns(id: string, user: Principal): Promise<string[]> {
  return (await datasetColumnsTyped(id, user)).map((c) => c.name);
}

/** The number of sample rows the Design assistant is grounded in for the selected dataset. */
export const GROUNDING_SAMPLE_ROWS = 5;

export type DatasetSample = { columns: string[]; rows: string[][] };

/**
 * A SMALL sample of REAL rows (first {@link GROUNDING_SAMPLE_ROWS}) of a dataset's furthest-built
 * layer, read AS the caller through the SAME governed preview path the Data tab uses
 * (`select * … limit n` via `queryRun`) — so row filters + column masks ride along and a masked
 * value samples masked. Returns null when the dataset isn't visible or has nothing built yet, so
 * the assistant is grounded ONLY in real values, never fabricated ones.
 */
export async function datasetSample(
  id: string,
  user: Principal,
  rows: number = GROUNDING_SAMPLE_ROWS,
): Promise<DatasetSample | null> {
  const target = resolveBuiltTarget(id, user);
  if (!target) return null;
  try {
    const res = await queryRun(previewSql(target.fqn, Math.max(1, Math.floor(rows))), target.principal);
    if (!res.columns.length) return null;
    return { columns: res.columns, rows: res.rows };
  } catch {
    return null;
  }
}

/** How many visible datasets we spell out columns for (context guard on a huge dataset list). */
export const GROUNDING_MAX_DATASETS = 25;
/** How many columns we list per dataset (a very wide table is truncated, not dumped). */
export const GROUNDING_MAX_COLS = 40;
/** How many characters of a sample cell we keep (a long text blob is truncated). */
const CELL_CLIP = 60;

/** Render one sample as a compact TSV-ish block (header + rows), cells clipped. */
function renderSample(sample: DatasetSample, maxCols = GROUNDING_MAX_COLS): string {
  const cols = sample.columns.slice(0, maxCols);
  const clip = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.length > CELL_CLIP ? `${s.slice(0, CELL_CLIP)}…` : s;
  };
  const head = cols.join(' | ');
  const body = sample.rows.map((r) => cols.map((_, i) => clip(r[i])).join(' | ')).join('\n');
  const more = sample.columns.length > cols.length ? `\n(+${sample.columns.length - cols.length} more columns)` : '';
  return `${head}\n${body}${more}`;
}

/**
 * Build the Design-stage grounding block: the caller's VISIBLE datasets each with their real
 * columns (name:type) so the assistant can pick the right dataset/target/inputs BEFORE one is
 * selected, plus a small sample of REAL rows for the currently-selected dataset so it can reason
 * about actual values. Everything is DLS-scoped (read AS the caller) and real — never fabricated.
 *
 * Context is bounded: columns (names+types) for up to {@link GROUNDING_MAX_DATASETS} datasets
 * ({@link GROUNDING_MAX_COLS} each), and sample VALUES for the SELECTED dataset only
 * ({@link GROUNDING_SAMPLE_ROWS} rows). When the assistant proposes a different dataset the user
 * hasn't opened yet, selecting it re-grounds this block with that dataset's values on the next turn.
 */
export async function designGrounding(user: Principal, selectedDatasetId: string): Promise<string> {
  const visible = visibleDatasets(user);
  const parts: string[] = [];

  if (!visible.length) {
    return 'Your datasets: (you have no datasets yet — the user must create or share one in the Data tab first).';
  }

  const shown = visible.slice(0, GROUNDING_MAX_DATASETS);
  const colLines = await Promise.all(
    shown.map(async (d) => {
      const cols = await datasetColumnsTyped(d.id, user);
      const listed = cols.slice(0, GROUNDING_MAX_COLS).map((c) => `${c.name}:${c.type}`).join(', ');
      const more = cols.length > GROUNDING_MAX_COLS ? ` (+${cols.length - GROUNDING_MAX_COLS} more)` : '';
      const colsText = cols.length ? `${listed}${more}` : '(no columns readable yet — not built)';
      return `${d.id} — ${d.name} [${d.scope}] columns: ${colsText}`;
    }),
  );
  const truncated = visible.length > shown.length ? `\n(+${visible.length - shown.length} more datasets — ask about them by name and I’ll list their columns)` : '';
  parts.push(
    'Your datasets (id — name [scope] columns: name:type, …) — reference ONLY these by exact id and ONLY their real columns:',
    colLines.join('\n') + truncated,
  );

  if (selectedDatasetId) {
    const ds = visible.find((d) => d.id === selectedDatasetId);
    if (ds) {
      const sample = await datasetSample(selectedDatasetId, user);
      if (sample) {
        parts.push(
          `Sample of the selected dataset (${ds.name}, ${ds.id}) — first ${sample.rows.length} REAL row(s), values may be masked by policy:`,
          renderSample(sample),
        );
      } else {
        parts.push(`Selected dataset (${ds.name}, ${ds.id}) has no readable rows yet (not built) — recommend from columns only.`);
      }
    }
  }

  return parts.join('\n\n');
}

export type RawDefinition = {
  datasetId?: unknown;
  targetColumn?: unknown;
  features?: unknown;
  taskType?: unknown;
  rationale?: unknown;
};

export type ValidatedDefinition = {
  datasetId: string;
  datasetFqn: string;
  datasetName: string;
  targetColumn?: string;
  features: string[];
  taskType?: 'binary_classification' | 'multiclass_classification' | 'regression';
  rationale?: string;
};

const TRAINABLE = new Set(['binary_classification', 'multiclass_classification', 'regression']);

/**
 * Validate a raw model definition the assistant proposed against the caller's real feed.
 * Returns the trusted definition (resolved dataset name/fqn from the registry, columns filtered
 * to ones that REALLY exist) or a `{ error }` naming what was hallucinated. A definition whose
 * dataset the caller can't see, or whose target column doesn't exist, is refused — the route
 * then renders no Apply card (only the assistant's prose stands).
 */
export async function validateDefinition(
  raw: RawDefinition,
  user: Principal,
): Promise<{ definition: ValidatedDefinition } | { error: string }> {
  const datasetId = typeof raw.datasetId === 'string' ? raw.datasetId : '';
  if (!datasetId) return { error: 'no dataset named' };
  const visible = visibleDatasets(user);
  const ds = visible.find((d) => d.id === datasetId);
  if (!ds) return { error: `named a dataset you cannot see (${datasetId})` };

  const cols = await datasetColumns(datasetId, user);
  const colSet = new Set(cols);

  const target = typeof raw.targetColumn === 'string' ? raw.targetColumn : undefined;
  if (target && cols.length > 0 && !colSet.has(target)) {
    return { error: `named a target column that isn’t in ${ds.name} (${target})` };
  }
  const featuresIn = Array.isArray(raw.features) ? raw.features.filter((f): f is string => typeof f === 'string') : [];
  // Keep only real columns (never the target). If we have a real column list, drop invented ones.
  const features = (cols.length > 0 ? featuresIn.filter((f) => colSet.has(f)) : featuresIn).filter((f) => f !== target);
  if (cols.length > 0 && featuresIn.length > 0 && features.length === 0) {
    return { error: `none of the suggested feature columns exist in ${ds.name}` };
  }

  const taskType = typeof raw.taskType === 'string' && TRAINABLE.has(raw.taskType) ? (raw.taskType as ValidatedDefinition['taskType']) : undefined;
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.slice(0, 400) : undefined;
  return {
    definition: {
      datasetId,
      datasetFqn: ds.fqn,
      datasetName: ds.name,
      targetColumn: target,
      features,
      taskType,
      rationale,
    },
  };
}
