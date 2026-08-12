/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { assistantComplete } from '@/lib/assistant/complete';
import { parseJsonReply } from '@/lib/assistant/json-reply';
import { roleModel } from '@/lib/models/roles';
import { roleAtLeast } from '@/lib/core/session';
import {
  createDataset,
  setDocs,
  getDataset,
  requestPromotion,
  type Principal,
  type PromotionRequest,
} from '@/lib/data/store';
import type { Dataset } from '@/lib/data/dataset-schema';
import { commitLayerVersion } from '@/lib/data/build/server';
import { publishPromotionLive } from '@/lib/data/publish-server';
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
 * The SERVER twin of the data-plan (0.6.101, hardened 0.6.112) — RESOLVE one create-new
 * dataset need the Design assistant proposed. This is the (b)/(c) actions of the
 * data-resolution step:
 *
 *   • fill 'empty' → create a governed dataset with the inferred SCHEMA and NO rows;
 *   • fill 'dummy' → same, plus N REALISTIC sample rows persisted through the EXACT bronze
 *     ingest path a file upload uses.
 *
 * 0.6.112 — APP-READABLE datasets. An OS-built app reads its granted data AS WHOEVER opens
 * it (the ambient end-user session), NOT a fixed app principal. A Personal (`dataset`-tier)
 * dataset is OWNER-ONLY (`canView`) and is not governed in Trino (`governanceFor` returns
 * null for `dataset`), so a created-Personal-then-granted dataset can be read only by its
 * owner — every other domain user 403s. So after landing bronze we drive the dataset to a
 * Domain `asset` in the app's domain via the SANCTIONED path (build Silver+Gold from the
 * landed bronze with the SAME `commitLayerVersion` the Data tab / MCP `add_dataset_version`
 * use, then `publishPromotionLive` — the real promote publish), and grant the app read on
 * the now-Domain dataset. `canView` then admits domain peers, Trino governs the asset, and
 * the domain-schema FQN resolves for ANY domain user.
 *
 * HONESTY FALLBACK. Promotion needs a Builder+ (the `promote` role floor) AND a reachable
 * materialization backend. When the caller is only a Creator, or the bronze did not
 * physically land, or the publish returns `{ok:false}`, we do NOT pretend it worked and we
 * do NOT silently leave the app with an owner-only grant: we land Personal, still grant it
 * (so the owner's own build/preview works) BUT return a LOUD, explicit `warning` that only
 * the owner can read it and a Builder must promote it (from the Data tab) before the app
 * reads it for other users. The `DataPlanPanel` surfaces the warning.
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
  /** Whether the dataset was promoted to a Domain asset (readable by domain peers). */
  promoted: boolean;
  /** LOUD owner-only warning when the dataset stayed Personal (Creator / offline / ✗). */
  warning?: string;
  app: App;
};

/**
 * The build + promote steps are INJECTED (the pattern `publishApprovedPromotion` uses) so
 * the whole create→build→promote→grant chain is unit-testable against pure-registry fakes,
 * without wiring the physical Trino build runner. Defaults are the real server functions.
 */
export type DataPlanDeps = {
  /** Build one medallion layer (Silver/Gold) as a pass-through of the prior layer — the
   *  SAME honest commit the Data tab / MCP `add_dataset_version` use. */
  buildLayer(
    dataset: Dataset,
    layer: 'silver' | 'gold',
    user: Principal,
  ): Promise<{ ok: boolean; dataset?: Dataset; error?: string }>;
  /** Approve + physically publish a promotion (Personal → Domain asset) AS the approver. */
  promote(
    req: PromotionRequest,
    approver: Principal,
  ): Promise<{ ok: boolean; fqn: string; dataset?: Dataset; error?: string }>;
};

const REAL_DEPS: DataPlanDeps = {
  buildLayer: async (dataset, layer, user) => {
    const out = await commitLayerVersion(dataset, layer, user, { passThrough: true });
    return { ok: out.ok, dataset: out.dataset, error: out.error };
  },
  promote: async (req, approver) => {
    const out = await publishPromotionLive(req, approver);
    return out.ok
      ? { ok: true, fqn: out.fqn, dataset: out.dataset }
      : { ok: false, fqn: out.fqn, error: out.error };
  },
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

/** The user's identity as the data store's {@link Principal} (id/domains/role). */
function principalOf(user: CurrentUser): Principal {
  return { id: user.id, domains: user.domains, role: user.role };
}

/** The LOUD owner-only warning (surfaced in the DataPlanPanel + returned in the result)
 *  when the dataset could not be promoted to the domain. */
function ownerOnlyWarning(name: string, why: string): string {
  return (
    `«${name}» was created in your PRIVATE space and only YOU can read it — ${why}. ` +
    `A Builder must promote it to the domain before the app can read it for OTHER users. ` +
    `(Bring Silver + Gold in the Data tab, then have a Builder approve its promotion to a domain asset.)`
  );
}

/**
 * Resolve ONE create-new data-plan item end to end: create the governed dataset, land its
 * bronze, build Silver+Gold, PROMOTE it to a Domain asset (so any domain user can read it
 * through the app), then GRANT the app read on it. On the honesty fallback (Creator /
 * offline / failed publish) it leaves the dataset Personal, still grants it, and returns a
 * LOUD owner-only `warning`. Throws (403/404/409/400) on an edit-scope / duplicate-name /
 * no-column violation — the same governed errors the Data + Design paths raise.
 */
export async function resolveDataPlanItem(
  appId: string,
  user: CurrentUser,
  item: SuggestedDataset,
  deps: DataPlanDeps = REAL_DEPS,
): Promise<ResolveDataPlanResult> {
  // Edit-scope FIRST: a viewer can't scaffold data onto someone else's app.
  const app = await getAppForUser(appId, user);
  if (!Array.isArray(item.columns) || item.columns.length === 0) {
    throw Object.assign(new Error('a create-new dataset needs at least one column'), { status: 400 });
  }

  const p = principalOf(user);

  // 1) Create the governed dataset in the APP'S domain (not just the caller's default) so a
  //    promoted asset lands in the schema the app resolves against; seed its schema so the
  //    build always has columns even before physical landing.
  const ds = createDataset(p, { name: item.name, domain: app.domain });
  seedSchema(ds.id, user, item.columns);

  // 2) Materialize its bronze through the SAME path a file upload uses. 'empty' lands a
  //    header-only grid (0 rows); 'dummy' generates realistic rows first.
  const grid = item.fill === 'dummy'
    ? await generateDummyGrid(user, item)
    : { columns: item.columns.map((c) => c.name), rows: [] };
  const landing = await landGridAsBronze(user, ds.id, grid);
  const rowsPersisted = grid.rows.length;

  // The grant helper — reused by both the promoted and the fallback path. Reference/sample
  // data is READ (never a write target); read-only is the correct, non-regressing default.
  const cap = contextAccessCap('read-only');
  const grantApp = async (): Promise<App> => {
    const grants = setGrant(app.grants, 'data', ds.id, 'read-only', cap);
    return patchAppDesign(appId, user, { grants });
  };

  const base = { datasetId: ds.id, datasetName: ds.name, fill: item.fill, rowsPersisted } as const;

  // 3) HONESTY FALLBACK — bronze did not physically land: nothing to promote. Grant it (so
  //    the owner's own build/preview works) with a LOUD warning; never a silent owner-only grant.
  if (!landing.ok) {
    return {
      ...base,
      materialized: false,
      promoted: false,
      warning: ownerOnlyWarning(ds.name, 'its data has not landed yet (the materialization backend is offline)'),
      app: await grantApp(),
    };
  }

  // 4) HONESTY FALLBACK — a Creator cannot promote (separation of duties: `promote` needs a
  //    Builder+). Land Personal, grant it (so the owner's own build/preview works), warn loudly
  //    so a Builder can promote it from the Data tab. We do NOT auto-file a request here (the
  //    warning is the explicit hand-off) — never a silent domain flip.
  if (!roleAtLeast(user.role, 'builder')) {
    return {
      ...base,
      materialized: true,
      promoted: false,
      warning: ownerOnlyWarning(ds.name, 'you are a Creator, so you cannot promote it yourself'),
      app: await grantApp(),
    };
  }

  // 5) Build Silver then Gold from the landed bronze (pass-through — the SAME honest commit
  //    the Data tab uses), so a Gold table exists to promote. A failed build ⇒ warn + grant.
  const built = getDataset(ds.id, p); // re-read: bronze is now built
  const silver = await deps.buildLayer(built, 'silver', p);
  const gold = silver.ok && silver.dataset ? await deps.buildLayer(silver.dataset, 'gold', p) : silver;
  if (!gold.ok || !gold.dataset) {
    return {
      ...base,
      materialized: true,
      promoted: false,
      warning: ownerOnlyWarning(ds.name, `its Silver/Gold could not be built (${gold.error ?? 'build did not pass'})`),
      app: await grantApp(),
    };
  }

  // 6) Promote Personal → Domain asset via the SANCTIONED publish (approve AS the owner —
  //    they are Builder+). Grant the app the domain read on ✓; else warn + owner grant.
  const req = requestPromotion(ds.id, p); // domain asset, domain-read grant, target FQN
  const promotion = await deps.promote(req, p);
  if (!promotion.ok) {
    return {
      ...base,
      materialized: true,
      promoted: false,
      warning: ownerOnlyWarning(ds.name, `its promotion did not pass (${promotion.error ?? 'publish failed'})`),
      app: await grantApp(),
    };
  }

  return {
    ...base,
    materialized: true,
    promoted: true,
    app: await grantApp(),
  };
}
