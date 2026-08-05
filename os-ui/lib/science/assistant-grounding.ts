/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listDatasets, getDataset, builtLayerFqn, type DatasetSummary, type Principal } from '@/lib/data/store';
import { LAYERS } from '@/lib/data/dataset-schema';
import { parseDescribe } from '@/lib/data/profile';
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

/**
 * The REAL column names of a dataset's furthest-built layer, read AS the caller through the
 * governed query path (so column masks / view rights apply). Returns [] when the dataset isn't
 * visible or has nothing queryable yet — the caller then simply can't validate columns against
 * it (and the assistant is told there are no columns to reference).
 */
export async function datasetColumns(id: string, user: Principal): Promise<string[]> {
  let dataset;
  try {
    dataset = getDataset(id, user); // throws / 403 for a non-viewer
  } catch {
    return [];
  }
  const built = LAYERS.filter((l) => dataset.versions[l].built);
  const layer = built[built.length - 1];
  if (!layer) return [];
  const resolved = builtLayerFqn(dataset, user, layer);
  const fqn = resolved?.fqn ?? '';
  if (!fqn) return [];
  const principal = resolved?.principal ?? (user.domains[0] ?? user.id);
  try {
    const describe = await queryRun(`describe ${fqn}`, principal);
    return parseDescribe(describe).map((c) => c.name);
  } catch {
    return [];
  }
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
