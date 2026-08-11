/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { assistantComplete } from '@/lib/assistant/complete';
import { parseJsonReply } from '@/lib/assistant/json-reply';
import { roleModel } from '@/lib/models/roles';
import { createDataset, setDocs } from '@/lib/data/store';
import { landGridAsBronze } from '@/lib/data/ingest';
import { getAppForUser, patchAppDesign, type App } from '@/lib/software/apps';
import { setGrant, contextAccessCap } from '@/lib/core/context-grants';
import {
  boundDummyRows,
  dummyGridFromRows,
  type Grid,
  type SuggestedColumn,
  type SuggestedDataset,
} from '@/lib/software/data-plan';

/**
 * The SERVER twin of the data-plan (0.6.101) — RESOLVE one create-new dataset need the
 * Design assistant proposed. This is the (b)/(c) actions of the data-resolution step:
 *
 *   • fill 'empty' → create a governed dataset in the user's personal lane with the
 *     inferred SCHEMA and NO rows (0-row bronze), then grant it to the app;
 *   • fill 'dummy' → same, plus generate N REALISTIC sample rows (AI, bounded) and
 *     PERSIST them through the EXACT bronze ingest path a file upload uses
 *     (`landGridAsBronze`: CSV → data-runner → iceberg.personal_<uid>.bronze_<slug>),
 *     then grant it. The rows are REAL persisted sample data — never fabricated at read
 *     time — and the dataset is LABELLED sample so it is never mistaken for production.
 *
 * The (a) action (BIND an existing dataset) is the pre-existing `suggestedGrants` path;
 * it never reaches here. Reuse is deliberate: `createDataset` + `landGridAsBronze` are the
 * SAME functions the Data tab uses — no new materialization is invented, and bronze stays
 * raw (all_varchar). Edit-scope on the app is enforced by `patchAppDesign` (owner/admin).
 */

/** The clear marker appended to a created dataset's description so the UI + any reader
 *  always sees it is app-scaffolded sample data, not a curated production source. */
const SAMPLE_MARK = '[sample data — created by the Software builder for a demo]';

/** The outcome of resolving one plan item: the created dataset id + the updated app. */
export type ResolveDataPlanResult = {
  datasetId: string;
  datasetName: string;
  fill: SuggestedDataset['fill'];
  /** Rows actually persisted (0 for 'empty'; the bounded count for 'dummy'). */
  rowsPersisted: number;
  /** Whether the physical bronze landed queryable (false on the offline teaching mock). */
  materialized: boolean;
  app: App;
};

/** Build the system+user prompt that asks the model for realistic sample rows. */
function dummyRowsMessages(ds: SuggestedDataset, n: number) {
  const schema = ds.columns.map((c) => `${c.name} (${c.type})`).join(', ');
  return [
    {
      role: 'system' as const,
      content: [
        'You generate REALISTIC, plausible SAMPLE data rows for a demo dataset. The rows are persisted as real sample data (clearly labelled sample), so they must look genuine but must NOT be real people or confidential records — invent plausible values.',
        'Respond with STRICT JSON only (no prose, no code fences): { "rows": [ { <column>: <value>, … }, … ] }.',
        'Every row object uses EXACTLY the given column names as keys. Keep values simple scalars (strings/numbers/booleans/dates as strings). Vary the data so it reads like a real table.',
      ].join('\n'),
    },
    {
      role: 'user' as const,
      content: [
        `Dataset: "${ds.name}"${ds.purpose ? ` — ${ds.purpose}` : ''}.`,
        `Columns: ${schema}.`,
        `Generate ${n} rows.`,
      ].join('\n'),
    },
  ];
}

/**
 * Generate up to `n` realistic sample rows for the dataset via the assistant model, folded
 * into the {@link Grid} the bronze ingest lands. Fails SOFT: if the model is unreachable or
 * returns no usable rows, returns a header-only grid (0 rows) — the create-dummy then lands
 * an empty-but-schema'd dataset rather than throwing, so the flow never dead-ends. The
 * caller reports `rowsPersisted` honestly from the grid it actually landed.
 */
export async function generateDummyGrid(user: CurrentUser, ds: SuggestedDataset): Promise<Grid> {
  const n = boundDummyRows(ds.rows);
  const header: Grid = { columns: ds.columns.map((c) => c.name), rows: [] };
  try {
    const { content } = await assistantComplete(dummyRowsMessages(ds, n), {
      user: { id: user.id, domains: user.domains },
      model: roleModel('reasoning'),
    });
    const parsed = parseJsonReply(content);
    const rows = parsed && typeof parsed === 'object' ? (parsed as { rows?: unknown }).rows : undefined;
    const grid = dummyGridFromRows(ds.columns, rows, n);
    return grid.rows.length > 0 ? grid : header;
  } catch {
    return header; // model down / cost-capped → schema-only, honest (no fabricated rows)
  }
}

/** Preload the inferred schema onto a freshly-created dataset so the build ALWAYS sees it,
 *  even when the physical bronze can't be probed (offline). Columns only; bronze stays raw. */
function seedSchema(datasetId: string, user: CurrentUser, columns: SuggestedColumn[]): void {
  setDocs(datasetId, user, {
    description: SAMPLE_MARK,
    columns: columns.map((c) => ({ name: c.name, description: '' })),
  });
}

/**
 * Resolve ONE create-new data-plan item end to end: create the governed dataset, land its
 * bronze (empty or dummy rows) through the shared ingest path, then GRANT it to the app so
 * the build sees its schema (the 0.6.97 granted-only build context). Returns the created
 * id + the updated app. Throws (403/404/409) on an edit-scope / duplicate-name violation —
 * the same governed errors the Data + Design paths raise.
 */
export async function resolveDataPlanItem(
  appId: string,
  user: CurrentUser,
  item: SuggestedDataset,
): Promise<ResolveDataPlanResult> {
  // Edit-scope FIRST: a viewer can't scaffold data onto someone else's app.
  const app = await getAppForUser(appId, user);
  if (!Array.isArray(item.columns) || item.columns.length === 0) {
    throw Object.assign(new Error('a create-new dataset needs at least one column'), { status: 400 });
  }

  // 1) Create the governed dataset in the caller's personal lane, then seed its schema so
  //    the build always has columns to write against (independent of physical landing).
  const ds = createDataset(user, { name: item.name });
  seedSchema(ds.id, user, item.columns);

  // 2) Materialize its bronze through the SAME path a file upload uses. 'empty' lands a
  //    header-only grid (0 rows); 'dummy' generates realistic rows first. `landGridAsBronze`
  //    requires ≥1 column (satisfied) and registers the bronze ONLY on a real, queryable
  //    landing — degrading to the honest offline-mock on a laptop.
  const grid = item.fill === 'dummy' ? await generateDummyGrid(user, item) : { columns: item.columns.map((c) => c.name), rows: [] };
  const landing = await landGridAsBronze(user, ds.id, grid);

  // 3) Grant the new dataset to the app (read-only — sample/scaffolded data is never a write
  //    target) so the build's granted-only context now includes its schema.
  const cap = contextAccessCap('read-only');
  const grants = setGrant(app.grants, 'data', ds.id, 'read-only', cap);
  const updated = await patchAppDesign(appId, user, { grants });

  return {
    datasetId: ds.id,
    datasetName: ds.name,
    fill: item.fill,
    rowsPersisted: grid.rows.length,
    materialized: landing.ok,
    app: updated,
  };
}
