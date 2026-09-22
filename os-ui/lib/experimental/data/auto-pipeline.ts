/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Role } from '@/lib/core/session';
import { queryRun } from '@/lib/infra/governed';
import type { Dataset } from './dataset-schema.ts';
import { getDataset, builtLayerFqn, addCheck } from './store.ts';
import { commitLayerVersion } from './build/server.ts';
import { suggestChecks, describeSuggestion, type SuggestedCheck } from './dq-suggest.ts';
import {
  assembleProfile,
  parseDescribe,
  previewSql,
  statsSql,
  topValuesSql,
  type Profile,
  type ProfileColumn,
} from './profile.ts';

/**
 * AUTO-ADVANCE THE PIPELINE after a fresh Bronze upload (Data tab).
 *
 * The user's ask: "create everything after you upload a file — store the bronze, silver and
 * gold version, create doc and DQ rules and store them automatically without a need to press
 * additional buttons. The user can still override afterwards." Bronze + docs already run in
 * the ingest path; THIS module chains the rest, BEST-EFFORT, right after the Bronze commit:
 *
 *   Silver (pass-through)  →  Gold (pass-through)  →  suggest + STORE default DQ rules
 *
 * Every stage is INDEPENDENT: one failing (or offline, or unreachable) logs + continues and
 * NEVER aborts the rest or the upload. It reuses the EXACT governed functions the manual
 * buttons call — `commitLayerVersion` (the same honest verify-then-dot Silver/Gold build) and
 * `addCheck` (the same governed checks write, canEdit-gated) — so nothing is reimplemented and
 * the honesty contract (no dot without a queryable table) is preserved. Bronze stays RAW: the
 * pass-through is a `SELECT *` copy forward — NO type coercion is introduced here.
 *
 * Nothing is LOCKED: the stored Silver/Gold versions rebuild, and the auto-stored checks
 * edit/delete, through the same surfaces as any hand-made artifact. The auto-stored checks
 * carry their deterministic plain-language `description` (from {@link describeSuggestion}), so
 * the user can SEE they were derived from the profile and override any of them.
 *
 * This is a FIRE-AND-FORGET async, matching `autoDocumentAfterIngest`: the ingest response
 * never waits on it.
 */

/** The dataset owner identity the governed builds/writes run as (the session user). */
export type PipelineUser = { id: string; domains: string[]; role: Role };

/**
 * Profile the dataset's furthest built layer through the SAME governed path the Validate
 * (`/dq`) route uses, so the caller's OPA masks apply. Returns null when nothing is queryable
 * yet (never throws for the auto-path — a miss just yields no suggestions).
 */
async function profileBuiltLayer(dataset: Dataset, user: PipelineUser): Promise<Profile | null> {
  const resolved = builtLayerFqn(dataset, user);
  if (!resolved) return null;
  try {
    const describe = await queryRun(`describe ${resolved.fqn}`, resolved.principal);
    const columns: ProfileColumn[] = parseDescribe(describe);
    const statsRes = await queryRun(statsSql(resolved.fqn, columns), resolved.principal);
    const previewRes = await queryRun(previewSql(resolved.fqn, 50), resolved.principal);
    let topRes = null;
    if (columns.length > 0 && columns.length <= 40) {
      const sql = topValuesSql(resolved.fqn, columns, 5);
      if (sql) {
        try { topRes = await queryRun(sql, resolved.principal); } catch { topRes = null; }
      }
    }
    return assembleProfile({ fqn: resolved.fqn, layer: resolved.layer, columns, statsRes, topRes, previewRes });
  } catch {
    return null; // not materialised/queryable yet — no suggestions, no throw.
  }
}

/** Persist one suggested rule as a governed check, carrying its deterministic description. */
function storeSuggestion(datasetId: string, user: PipelineUser, s: SuggestedCheck): void {
  addCheck(datasetId, user, {
    name: `${s.rule}(${s.column})`,
    description: s.description ?? describeSuggestion(s) ?? '',
    rule: s.rule,
    column: s.column,
    values: s.values,
    min: s.min,
    max: s.max,
  });
}

/** The outcome of the auto-advance — each stage independently true/false (for logs/tests). */
export type AutoPipelineResult = { silver: boolean; gold: boolean; checks: number };

/**
 * Run Silver → Gold → suggest+store DQ, best-effort, after Bronze commits. Each stage is
 * wrapped so a failure logs + continues. Returns which stages landed (checks = count stored).
 *
 * Effects are INJECTED so the orchestration is unit-testable without a live stack:
 *   - `commit`  — commit a layer (defaults to the real `commitLayerVersion` pass-through).
 *   - `reload`  — re-read the dataset after a build (the store mutates; defaults to `getDataset`).
 *   - `profile` — profile the built layer (defaults to {@link profileBuiltLayer}).
 *   - `store`   — persist one suggested check (defaults to {@link storeSuggestion}).
 */
export async function autoAdvancePipeline(
  datasetId: string,
  user: PipelineUser,
  deps: {
    commit?: (dataset: Dataset, layer: 'silver' | 'gold') => Promise<boolean>;
    reload?: (id: string) => Dataset;
    profile?: (dataset: Dataset) => Promise<Profile | null>;
    store?: (s: SuggestedCheck) => void;
  } = {},
): Promise<AutoPipelineResult> {
  const commit =
    deps.commit ??
    (async (dataset, layer) => (await commitLayerVersion(dataset, layer, user, { passThrough: true, quality: 'unknown' })).ok);
  const reload = deps.reload ?? ((id) => getDataset(id, user));
  const profile = deps.profile ?? ((dataset) => profileBuiltLayer(dataset, user));
  const store = deps.store ?? ((s) => storeSuggestion(datasetId, user, s));

  const result: AutoPipelineResult = { silver: false, gold: false, checks: 0 };

  // Silver — pass-through copy of Bronze. Independent: a failure logs + continues to Gold.
  try {
    result.silver = await commit(reload(datasetId), 'silver');
  } catch (e) {
    console.warn(`[auto-pipeline] silver skipped for ${datasetId}:`, (e as Error).message);
  }

  // Gold — pass-through of the furthest built layer (Silver if it landed, else Bronze).
  try {
    result.gold = await commit(reload(datasetId), 'gold');
  } catch (e) {
    console.warn(`[auto-pipeline] gold skipped for ${datasetId}:`, (e as Error).message);
  }

  // DQ — profile the furthest built layer, suggest the OBVIOUS rules, and STORE them (minus
  // any the dataset already has — `suggestChecks` dedupes). All best-effort.
  try {
    const dataset = reload(datasetId);
    const prof = await profile(dataset);
    if (prof) {
      const suggestions = suggestChecks(prof, dataset.checks ?? []);
      for (const s of suggestions) {
        try {
          store(s);
          result.checks++;
        } catch (e) {
          console.warn(`[auto-pipeline] check ${s.rule}(${s.column}) skipped for ${datasetId}:`, (e as Error).message);
        }
      }
    }
  } catch (e) {
    console.warn(`[auto-pipeline] dq skipped for ${datasetId}:`, (e as Error).message);
  }

  return result;
}
