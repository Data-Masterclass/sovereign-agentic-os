/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listDatasets, getDataset, builtLayerFqn, type DatasetSummary, type Principal } from '@/lib/data/store';
import { LAYERS } from '@/lib/data/dataset-schema';
import { parseDescribe, previewSql, classifyType, type ProfileColumn } from '@/lib/data/profile';
import { slug } from '@/lib/data/store-fqn';
import { queryRun } from '@/lib/infra/governed';
import { inferTaskFromTarget, type TargetProfile, type InferredTask } from '@/lib/science/infer-task';

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

/** Double-quote-escape an identifier so a column name can't break out of the SQL. */
function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Profile the REAL CONTENT of a target column with ONE cheap, governed, DLS-scoped query — so the
 * task inference reads the actual values, not just the declared (bronze-raw, often misleading)
 * type. Returns row count, distinct count, non-null count and — for NUMERIC types only — whether
 * every non-null value is a whole number (`isIntegerValued`), which separates a continuous double
 * (regression) from a low-cardinality integer category (multiclass). FAIL-SOFT: any error / a
 * missing column / a non-queryable dataset → `undefined` (the caller falls back to type-only).
 * A single round-trip; the numeric integer-valued probe is skipped for non-numeric columns.
 */
export async function targetProfile(
  id: string,
  column: string,
  type: string,
  user: Principal,
): Promise<{ distinctCount: number; nonNull: number; rowCount: number; isIntegerValued?: boolean } | undefined> {
  const target = resolveBuiltTarget(id, user);
  if (!target || !column) return undefined;
  const col = quoteIdent(column);
  const numeric = classifyType(type) === 'numeric';
  // For numeric targets, also count how many non-null values are NOT whole numbers. If that count
  // is 0 the column is integer-valued (categories possible); if > 0 it's fractional ⇒ continuous.
  const fractionalExpr = numeric
    ? `, count_if(cast(${col} as double) <> round(cast(${col} as double))) as frac`
    : '';
  const sql =
    `select count(*) as n, count(distinct ${col}) as distinct_n, count(${col}) as non_null${fractionalExpr} from ${target.fqn}`;
  try {
    const res = await queryRun(sql, target.principal);
    const row = res.rows?.[0];
    if (!row) return undefined;
    const idx = (name: string) => res.columns.findIndex((c) => c.toLowerCase() === name);
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const rowCount = num(row[idx('n')]);
    const distinctCount = num(row[idx('distinct_n')]);
    const nonNull = num(row[idx('non_null')]);
    if (rowCount === undefined || distinctCount === undefined || nonNull === undefined) return undefined;
    let isIntegerValued: boolean | undefined;
    if (numeric) {
      const frac = num(row[idx('frac')]);
      if (frac !== undefined) isIntegerValued = frac === 0;
    }
    return { distinctCount, nonNull, rowCount, isIntegerValued };
  } catch {
    return undefined;
  }
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
  /** True when the OS set/overrode `taskType` from the target column itself (dtype + content). */
  autoDetectedTask?: boolean;
  /** Human reason for the auto-detection (shown in the Simple flow when `autoDetectedTask`). */
  autoDetectedReason?: string;
};

const TRAINABLE = new Set(['binary_classification', 'multiclass_classification', 'regression']);
const CLASSIFICATION = new Set(['binary_classification', 'multiclass_classification']);

/** How an inferred task reads for a business user, for the auto-detected note. */
const TASK_WORD: Record<NonNullable<InferredTask>, string> = {
  binary_classification: 'binary classification',
  multiclass_classification: 'multiclass classification',
  regression: 'regression',
};

/** A short, human reason for an auto-detected task, naming the target and why. */
function autoDetectReason(task: NonNullable<InferredTask>, target: string, type: string, profile?: TargetProfile): string {
  const t = (type || '').trim().toLowerCase();
  if (task === 'regression') {
    const why = profile?.isIntegerValued === false ? 'a continuous numeric column with fractional values' : `a continuous numeric column (${t || 'numeric'})`;
    return `Task auto-detected as regression: target «${target}» is ${why}.`;
  }
  if (task === 'binary_classification') {
    const why = profile?.distinctCount === 2 ? 'has exactly two distinct values' : `is a ${t || 'boolean'} column`;
    return `Task auto-detected as binary classification: target «${target}» ${why}.`;
  }
  const n = profile?.distinctCount;
  return `Task auto-detected as multiclass classification: target «${target}» has a small set of categories${typeof n === 'number' ? ` (${n})` : ''}.`;
}

/**
 * Validate a raw model definition the assistant proposed against the caller's real feed.
 * Returns the trusted definition (resolved dataset name/fqn from the registry, columns filtered
 * to ones that REALLY exist) or a `{ error }` naming what was hallucinated. A definition whose
 * dataset the caller can't see, or whose target column doesn't exist, is refused — the route
 * then renders no Apply card (only the assistant's prose stands).
 *
 * AUTO-DETECT (0.6.111): the assistant only PROPOSES `taskType`, and Simple users get NO task
 * selector — a wrong guess (binary_classification on a continuous `duration_days` double) aborts
 * training. So we read the target column's real TYPE + CONTENT (one cheap governed query) and
 * infer the task from the data. We USE the inferred task when the assistant omitted one, and
 * OVERRIDE a clearly-wrong one (classification proposed on a continuous target → regression, or a
 * regression proposed on a boolean/2-distinct target → binary), flagging it (`autoDetectedTask` +
 * reason) so the UI shows the correction transparently. When the inference can't say, we keep the
 * proposal untouched. This never fabricates: it reads the caller's own, DLS-scoped data.
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

  const typed = await datasetColumnsTyped(datasetId, user);
  const cols = typed.map((c) => c.name);
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

  const proposed = typeof raw.taskType === 'string' && TRAINABLE.has(raw.taskType) ? (raw.taskType as ValidatedDefinition['taskType']) : undefined;
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.slice(0, 400) : undefined;

  // Infer the task from the target column's real type + content (content-first). Fail-soft: no
  // target / no readable type / a failed profile query all degrade to "keep the proposal".
  let taskType = proposed;
  let autoDetectedTask: boolean | undefined;
  let autoDetectedReason: string | undefined;
  const targetType = target ? typed.find((c) => c.name === target)?.type : undefined;
  if (target && targetType) {
    const content = await targetProfile(datasetId, target, targetType, user);
    const profile: TargetProfile = { type: targetType, ...(content ?? {}) };
    const inferred = inferTaskFromTarget(profile);
    if (inferred) {
      // Set the task from the data when the assistant omitted one, or OVERRIDE a clearly-wrong one
      // (a classification proposed on a continuous target, or regression on a boolean/2-distinct
      // target). Either way the task now came from the target itself → flag it so the UI shows the
      // auto-detection. A proposal already CONSISTENT with the data is kept as-is (no flag).
      const proposalWrong =
        !proposed ||
        (CLASSIFICATION.has(proposed) && inferred === 'regression') ||
        (proposed === 'regression' && CLASSIFICATION.has(inferred));
      if (proposalWrong) {
        taskType = inferred;
        autoDetectedTask = true;
        autoDetectedReason = autoDetectReason(inferred, target, targetType, profile);
      }
    }
  }

  return {
    definition: {
      datasetId,
      datasetFqn: ds.fqn,
      datasetName: ds.name,
      targetColumn: target,
      features,
      taskType,
      rationale,
      autoDetectedTask,
      autoDetectedReason,
    },
  };
}
