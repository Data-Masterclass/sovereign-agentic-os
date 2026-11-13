/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One governed service function per data mutation — the SAME door for the UI route
 *             and the MCP tool (engine rebuild B4, checklist X8)
 * USER STORY: As a data engineer I want `create_dataset`, `add_dataset_version`, `transform_silver`,
 *             `build_gold_join`, `define_quality_rules`, `set_dataset_sync`, `sync_dataset_now` and
 *             `run_quality_checks` to do EXACTLY the same thing whether I drive the Data tab or the
 *             OS MCP — the same repo commit, the same Dagster launch, the same typed error.
 * ARCHITECTURE:
 *   - Each exported function IS the mutation: validation (400 naming the field), the governed store
 *     write (the store re-gates view/edit scope → 403/404), the physical build through the Build
 *     adapter, and — behind `DATA_PROJECT_GIT` — the commit (emitted by the store, committed by the
 *     one hook) and the Dagster launch. A route adds only HTTP shaping; an MCP tool only arg coercion.
 *   - Errors are thrown with an HTTP-ish `status` so both doors render the same envelope:
 *     `withRoute`/`errorResponse` turn it into `{error}` + status, `handleRpc` into a typed
 *     `{code, reason, hint}` (404 for an invisible object, 403 for a role gate, 400 for validation).
 *   - Nothing here reads a session: the caller passes the resolved `Principal`. Identity for the
 *     physical write is DERIVED from it, never from the request.
 *   - Cross-tab reads (the sync source's connection platform) use the lazy-import pattern of
 *     `sync-run-server.ts` and are injectable, so the unit tests need neither tab nor cluster.
 */
import 'server-only';
import { roleAtLeast } from '@core/kernel/session';
import { queryRun, type ExecuteIdentity } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';
import {
  createDataset,
  getDataset,
  buildVersion,
  buildGoldJoin,
  setDocs,
  addCheck,
  setDatasetSync,
  requireDatasetEditable,
  builtLayerFqn,
  type Principal,
} from '@tabs/data/lib/store';
import {
  DATASET_SYNC_MODES,
  DATA_CHECK_RULES,
  parseGoldSpec,
  type DataCheckRule,
  type DatasetSync,
  type DatasetSyncMode,
  type Dataset,
  type Layer,
  type Quality,
  type ColumnDoc,
  type DatasetUpstream,
} from '@tabs/data/lib/dataset-schema';
import { canBuildStage, canPassThrough, stageArtifact } from '@tabs/data/lib/panels';
import { buildStage, commitLayerVersion, type CommitVersionOutcome } from '@tabs/data/lib/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToModel,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type GoldDerived,
  type JoinType,
} from '@tabs/data/lib/transform';
import { reuseSourceFqn, composeSourceBlocker } from '@tabs/data/lib/store-fqn';
import { rematerializeDomainTableLive } from '@tabs/data/lib/publish-server';
import { runAndRecord, type DqRunOutcome } from '@tabs/data/lib/dq-run-server';
import {
  launchDatasetBuild,
  reconcileSyncSchedule,
  runSyncNow,
  type SyncCronOutcome,
} from '@tabs/data/lib/dbt/launch';
import { currentSurface } from '@core/infra/request-surface';

/** A thrown, status-tagged failure — the shape both doors already translate. */
export class DataMutationError extends Error {
  readonly status: number;
  /** The offending input field, when the failure is validation (checklist X8). */
  readonly field?: string;
  constructor(message: string, status: number, field?: string) {
    super(message);
    this.name = 'DataMutationError';
    this.status = status;
    this.field = field;
  }
}

function fail(message: string, status: number, field?: string): never {
  throw new DataMutationError(message, status, field);
}

/* ------------------------------------------------- the ambient test seam (B4) -- */

/**
 * The out-of-process dependencies a service reaches for, overridable in ONE place. A route and an
 * MCP tool both call these functions without injecting anything, so the parity harness
 * (checklist X8) needs a single seam to drive BOTH doors against the same fakes — no cluster, no
 * connection store, no Kubernetes. Production never sets it.
 */
export type MutationTestDeps = {
  platform?: SyncPlatformResolver;
  reconcile?: typeof reconcileSyncSchedule;
  queryFn?: (sql: string, principal?: string) => Promise<{ rows: string[][] }>;
  kajabiCursor?: (resource: string) => string | null;
};

let ambient: MutationTestDeps = {};

export function __setMutationDepsForTests(deps: MutationTestDeps | null): void {
  ambient = deps ?? {};
}

/** The governed WRITE identity, derived from the acting principal — never from the request. */
function executeIdentity(user: Principal): ExecuteIdentity {
  return { principal: user.domains[0] ?? user.id, uid: user.id, domains: user.domains, role: user.role };
}

/** `ui:<route>` / `mcp:<tool>` for the Dagster `os/surface` tag (absent outside a scope). */
function surface(): string | undefined {
  return currentSurface()?.surface;
}

/** The materialization-drift report both builders return (identical wording on both doors). */
export type DomainTableState = { state: 'refreshed' | 'stale' | 'not-promoted'; fqn?: string; reason?: string };

/**
 * Refresh the governed domain copy after a rebuild of an already-promoted dataset. Best-effort:
 * a failure NEVER fails the rebuild — it is reported honestly as `stale` with the reason.
 */
async function refreshDomainTable(
  dataset: Dataset,
  user: Principal,
  opts: { skipReason?: string } = {},
): Promise<DomainTableState> {
  if (dataset.tier === 'dataset') return { state: 'not-promoted' };
  if (opts.skipReason) return { state: 'stale', reason: opts.skipReason };
  if (!roleAtLeast(user.role, 'builder')) {
    return { state: 'stale', reason: 'Rebuilt by a creator — a Builder must re-promote to refresh the shared domain table.' };
  }
  try {
    const out = await rematerializeDomainTableLive(dataset.id, user);
    return out.ok ? { state: 'refreshed', fqn: out.fqn } : { state: 'stale', fqn: out.fqn, reason: out.error };
  } catch (e) {
    return { state: 'stale', reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------ create_dataset -- */

export type CreateDatasetInput = {
  name?: unknown;
  domain?: unknown;
  origin?: unknown;
  /** Optional column docs to seed in the same act (the MCP's `columns`). */
  columns?: ColumnDoc[];
};

/**
 * Create a private dataset (the Data tab's "New dataset" / MCP `create_dataset`). Seeding column
 * docs is part of the same mutation, so both doors produce the same commit sequence.
 */
export function createDatasetService(user: Principal, input: CreateDatasetInput): Dataset {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) fail('a dataset needs a name', 400, 'name');
  const domain = typeof input.domain === 'string' && input.domain.trim() ? input.domain.trim() : undefined;
  const origin = input.origin === 'curated' ? ('curated' as const) : undefined;
  const dataset = createDataset(user, { name, domain, origin });
  const columns = (input.columns ?? []).filter((c) => c.name);
  return columns.length ? setDocs(dataset.id, user, { columns }) : dataset;
}

/* ------------------------------------------------------- add_dataset_version -- */

export type VersionInput = { layer?: unknown; quality?: unknown; passThrough?: unknown; body?: unknown };

/**
 * Commit one medallion version — the guided panel's "Confirm" and MCP `add_dataset_version`, both
 * through `commitLayerVersion` (registered only on a ✓ materialize-or-probe report).
 */
export async function commitVersionService(user: Principal, datasetId: string, input: VersionInput): Promise<CommitVersionOutcome> {
  const layer = String(input.layer ?? '') as Layer;
  if (!['bronze', 'silver', 'gold'].includes(layer)) fail('layer must be bronze|silver|gold', 400, 'layer');
  const current = getDataset(datasetId, user); // view-scope guard (403/404)
  const passThrough = input.passThrough === true;
  // A pass-through carries the newest LOWER layer forward (gold probes silver→bronze), so it is
  // valid whenever ANY lower layer exists; an AUTHORED build needs its immediate prior.
  const priorPresent = passThrough
    ? current.versions.bronze.built || current.versions.silver.built
    : canBuildStage(current.versions, layer);
  if (!priorPresent) fail(`bring in the prior layer before building ${layer}`, 400, 'layer');
  if (passThrough && !canPassThrough(layer)) fail('Bronze is the entry point — there is nothing to pass through', 400, 'passThrough');
  return commitLayerVersion(current, layer, user, {
    passThrough,
    quality: (typeof input.quality === 'string' ? (input.quality as Quality) : undefined),
    body: typeof input.body === 'string' ? input.body : undefined,
  });
}

/* ----------------------------------------------------------- transform_silver -- */

export type BuildResult = {
  ok: boolean;
  build: Awaited<ReturnType<typeof buildStage>>;
  sql: string;
  target: string;
  /** Present on a ✓ only — nothing is registered on a ✗. */
  dataset?: Dataset;
  domainTable?: DomainTableState;
  error?: string;
  /** True when a Dagster run was scheduled from the commit (flag on). */
  launched?: boolean;
};

/**
 * Build the physical SILVER from guided ops — the Transform panel and MCP `transform_silver`.
 * One compiled CTAS, run AS the caller; the version is registered only on a ✓, then the layer's
 * dbt assets are launched in Dagster from the commit this write produced.
 */
export async function transformSilverService(
  user: Principal,
  datasetId: string,
  input: { columns?: unknown; ops?: unknown },
): Promise<BuildResult> {
  const dataset = getDataset(datasetId, user); // view-scope guard
  if (!canBuildStage(dataset.versions, 'silver')) {
    fail('Bring in the Bronze version before cleaning it', 400, 'layer');
  }
  const columns = Array.isArray(input.columns) ? (input.columns as string[]) : [];
  const ops = Array.isArray(input.ops) ? (input.ops as TransformOp[]) : [];
  const identity = executeIdentity(user);
  // Compiled SERVER-SIDE from the ops (a client can never send SQL). TransformError → 400.
  const plan = silverPlan(dataset, identity, columns, ops);
  // Personal-lane builds run under the UID so Trino→OPA sees the `personal_<uid>` owner.
  if (plan.schema.startsWith('personal_')) identity.principal = user.id;
  const build = await buildStage(dataset, 'silver', identity.principal, { transformSql: plan.sql, identity, targetFqn: plan.target });
  if (!build.ok) {
    const failed = build.rows.find((r) => r.status === 'fail');
    return { ok: false, build, sql: plan.sql, target: plan.target, error: failed?.error ?? 'Silver build did not pass' };
  }
  const updated = buildVersion(datasetId, user, 'silver', {
    quality: 'unknown',
    artifact: stageArtifact(dataset.name, 'silver'),
    body: plan.sql,
    compiled: true, // the body IS silverPlan's output ⇒ it becomes a dbt model
  });
  const launched = launchDatasetBuild({
    datasetId,
    layer: 'silver',
    actor: { id: user.id },
    principal: identity.principal,
    action: 'transform silver',
    surface: surface(),
  });
  // When SILVER is the published layer a Builder+'s rebuild refreshes the domain copy in the same
  // act; with a Gold on top the refresh belongs to the Gold rebuild (publishing now would copy a
  // still-stale personal Gold), so it stays honestly stale with the reason saying what to do.
  const domainTable = await refreshDomainTable(updated, user, {
    skipReason: updated.versions.gold.built ? 'Rebuild Gold to refresh the shared domain table (Gold is the published layer).' : undefined,
  });
  const dataset2 = domainTable.state === 'refreshed' ? getDataset(datasetId, user) : updated;
  return { ok: true, build, sql: plan.sql, target: plan.target, dataset: dataset2, domainTable, launched };
}

/* ------------------------------------------------------------ build_gold_join -- */

export type GoldJoinPick = { datasetId?: unknown; type?: unknown; on?: unknown };
export type GoldJoinInput = {
  baseDatasetId?: unknown;
  picks?: unknown;
  dimensions?: unknown;
  measures?: unknown;
  derived?: unknown;
  goldSpec?: unknown;
};

/**
 * REPAIR MODE — re-run only the publish CTAS (owner's personal gold → domain schema) for an
 * already-promoted dataset whose domain table is missing or stale. Builder+; never touches
 * versions, lineage or measures.
 */
export async function rematerializeDomainTableService(
  user: Principal,
  datasetId: string,
): Promise<{ ok: boolean; dataset: Dataset; domainTable: DomainTableState }> {
  const dataset = getDataset(datasetId, user); // view-scope guard
  if (dataset.tier === 'dataset') fail('Not promoted — nothing to re-materialize', 400, 'datasetId');
  if (!roleAtLeast(user.role, 'builder')) fail('Re-materializing the shared domain table needs Builder or above', 403);
  const out = await rematerializeDomainTableLive(datasetId, user);
  const domainTable: DomainTableState = out.ok
    ? { state: 'refreshed', fqn: out.fqn }
    : { state: 'stale', fqn: out.fqn, reason: out.error };
  return { ok: out.ok, dataset: getDataset(datasetId, user), domainTable };
}

/**
 * Build the physical GOLD by projecting (and optionally JOINING) datasets the caller may read —
 * the Composition panel and MCP `build_gold_join`. Every pick is re-resolved through the canView
 * guard and mapped to its OWNER-AWARE physical table (`reuseSourceFqn`), so a personal partner is
 * read in its personal lane; the measures, upstream lineage and the recorded spec land only on a ✓.
 */
export async function buildGoldJoinService(user: Principal, datasetId: string, input: GoldJoinInput): Promise<BuildResult> {
  const dataset = getDataset(datasetId, user); // view-scope guard on the base

  // A curated dataset has no own Silver: its base is an EXPLICIT dataset (ref 0), re-checked
  // through the same guard as a join partner.
  const rawBaseId = typeof input.baseDatasetId === 'string' ? input.baseDatasetId.trim() : '';
  let baseSource: string | undefined;
  let baseUpstream: DatasetUpstream | undefined;
  if (rawBaseId && rawBaseId !== datasetId) {
    const base = getDataset(rawBaseId, user); // 403/404
    const blocked = composeSourceBlocker(base);
    if (blocked) fail(blocked, 400, 'baseDatasetId');
    baseSource = reuseSourceFqn(base);
    baseUpstream = { datasetId: base.id, name: base.name, fqn: baseSource, joinType: 'inner' };
  }
  if (!baseSource && !canBuildStage(dataset.versions, 'gold')) {
    fail('Bring in the Silver version before joining it', 400, 'layer');
  }

  const rawPicks = Array.isArray(input.picks) ? (input.picks as GoldJoinPick[]) : [];
  const identity = executeIdentity(user);
  const joins: ResolvedJoin[] = [];
  const upstreams: DatasetUpstream[] = [];
  if (baseUpstream) upstreams.push(baseUpstream);
  for (const pick of rawPicks) {
    const up = getDataset(String(pick?.datasetId ?? '').trim(), user); // 403/404
    const blocked = composeSourceBlocker(up);
    if (blocked) fail(blocked, 400, 'picks');
    const fqn = reuseSourceFqn(up); // owner-aware: a personal partner resolves to its personal lane
    const type: JoinType = pick?.type === 'left' ? 'left' : 'inner';
    const on = Array.isArray(pick?.on) ? (pick.on as ResolvedJoin['on']) : [];
    joins.push({ table: fqn, type, on });
    upstreams.push({ datasetId: up.id, name: up.name, fqn, joinType: type });
  }

  const dimensions = Array.isArray(input.dimensions) ? (input.dimensions as GoldDimension[]) : [];
  const measures = Array.isArray(input.measures) ? (input.measures as GoldMeasure[]) : [];
  const derived = Array.isArray(input.derived) ? (input.derived as GoldDerived[]) : [];

  // Compiled server-side (TransformError → 400 with the real reason).
  const plan = goldJoinPlan(dataset, identity, joins, dimensions, measures, derived, baseSource);
  if (plan.schema.startsWith('personal_')) identity.principal = user.id;
  const build = await buildStage(dataset, 'gold', identity.principal, { transformSql: plan.sql, identity, targetFqn: plan.target });
  if (!build.ok) {
    const failed = build.rows.find((r) => r.status === 'fail');
    return { ok: false, build, sql: plan.sql, target: plan.target, error: failed?.error ?? 'Gold join did not pass' };
  }

  // The raw spec is sanitized server-side and `baseDatasetId` pinned to the ACTUALLY-resolved base.
  const parsedSpec = parseGoldSpec(input.goldSpec);
  const goldSpec = parsedSpec
    ? baseSource
      ? { ...parsedSpec, baseDatasetId: rawBaseId }
      : (() => {
          const { baseDatasetId: _drop, ...rest } = parsedSpec;
          return rest;
        })()
    : undefined;
  const updated = buildGoldJoin(datasetId, user, {
    measures: measures.map(goldMeasureToModel),
    upstreams,
    artifact: stageArtifact(dataset.name, 'gold'),
    body: plan.sql,
    goldSpec,
  });
  const launched = launchDatasetBuild({
    datasetId,
    layer: 'gold',
    actor: { id: user.id },
    principal: identity.principal,
    action: 'build gold join',
    surface: surface(),
  });
  const domainTable = await refreshDomainTable(updated, user);
  const dataset2 = domainTable.state === 'refreshed' ? getDataset(datasetId, user) : updated;
  return { ok: true, build, sql: plan.sql, target: plan.target, dataset: dataset2, domainTable, launched };
}

/* -------------------------------------------------------- define_quality_rules -- */

export type QualityRuleInput = {
  rule?: unknown;
  column?: unknown;
  name?: unknown;
  description?: unknown;
  values?: unknown;
  min?: unknown;
  max?: unknown;
};

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Add one or more quality rules — the DQ editor's "Add" and MCP `define_quality_rules`. A
 * STRUCTURED rule (rule + column) is executable and becomes a dbt test in the domain's project; a
 * bare name/description is a legacy free-text intention. An unknown `rule` is a 400 on both doors.
 */
export function defineQualityRulesService(user: Principal, datasetId: string, rules: QualityRuleInput[]): Dataset {
  if (rules.length === 0) fail('at least one rule is required', 400, 'rules');
  let dataset = getDataset(datasetId, user); // canView; addCheck re-gates canEdit
  for (const raw of rules) {
    const r = raw ?? {};
    const ruleName = typeof r.rule === 'string' ? r.rule.trim() : '';
    if (ruleName && !(DATA_CHECK_RULES as readonly string[]).includes(ruleName)) {
      fail(`unknown rule '${ruleName}' (${DATA_CHECK_RULES.join('|')})`, 400, 'rule');
    }
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const description = typeof r.description === 'string' ? r.description : '';
    if (!ruleName) {
      // Legacy free-text intention: it needs a name to mean anything.
      if (!name) fail('name is required', 400, 'name');
      dataset = addCheck(datasetId, user, { name, description });
      continue;
    }
    const rule = ruleName as DataCheckRule;
    const column = typeof r.column === 'string' ? r.column.trim() : '';
    if (!column) fail(`${rule} needs a column`, 400, 'column');
    dataset = addCheck(datasetId, user, {
      name: name || `${rule}(${column})`,
      description,
      rule,
      column,
      values: Array.isArray(r.values) ? r.values.map((x) => String(x)) : undefined,
      min: numOrUndef(r.min),
      max: numOrUndef(r.max),
    });
  }
  return dataset;
}

/* ---------------------------------------------------------- run_quality_checks -- */

export type DqRunDeps = { queryFn?: (sql: string, principal?: string) => Promise<{ rows: string[][] }> };

/**
 * Run a dataset's rules AND its heuristic monitors through the governed query path AS THE OWNER,
 * and persist one run to the durable series — the "Run checks" button and MCP `run_quality_checks`.
 * This is the OS's own ad-hoc probe (labelled `source: 'os'`); the SCHEDULED verdict is the dbt
 * tests Dagster runs, read back as asset checks.
 */
export async function runQualityChecksService(
  user: Principal,
  datasetId: string,
  deps: DqRunDeps = {},
): Promise<DqRunOutcome & { datasetId: string; name: string }> {
  const dataset = getDataset(datasetId, user); // canView gate
  const resolved = builtLayerFqn(dataset, user); // { fqn, principal } | null
  const run = deps.queryFn ?? ambient.queryFn ?? queryRun;
  const outcome = await runAndRecord(dataset, {
    fqn: resolved?.fqn ?? null,
    queryFn: (sql) => run(sql, resolved?.principal),
    ownerId: user.id,
  });
  return { datasetId, name: dataset.name, ...outcome };
}

/* ------------------------------------------------------------ set_dataset_sync -- */

/** The SyncPanel's schedule presets, verbatim — accepted on both doors. */
export const SYNC_SCHEDULE_PRESETS: Record<string, string> = {
  'every-15-minutes': '*/15 * * * *',
  'every-30-minutes': '*/30 * * * *',
  hourly: '0 * * * *',
  daily: '0 6 * * *',
  weekly: '0 6 * * 1',
};

/** A preset name or a raw 5-field cron → the cron the schedule is saved with. */
export function cronFromSchedule(schedule: string): string {
  return SYNC_SCHEDULE_PRESETS[schedule.trim().toLowerCase()] ?? schedule.trim();
}

export type SyncPlatformResolver = (connectionId: string, user: Principal) => Promise<string | null>;

/** The source connection's sync platform, resolved AS the caller through the governed connection
 *  store (lazy import — the connections graph stays out of this module's static graph; the cast is
 *  safe because `visibleToUser` reads only id/domains/role, which `Principal` carries). */
async function livePlatform(connectionId: string, user: Principal): Promise<string | null> {
  const { getConnectionForUser } = await import('@tabs/connections/lib/store');
  const c = await getConnectionForUser(connectionId, user as CurrentUser);
  return c.template === 'warehouse' && c.warehouse
    ? c.warehouse.platform
    : c.template === 'salesforce-api'
      ? 'salesforce'
      : c.template === 'kajabi-api'
        ? 'kajabi'
        : null;
}

export type SaveSyncDeps = {
  platform?: SyncPlatformResolver;
  reconcile?: typeof reconcileSyncSchedule;
  /** The Kajabi resource → documented cursor field map (injected for tests). */
  kajabiCursor?: (resource: string) => string | null;
};

export type SaveSyncResult = { datasetId: string; platform: string | null; sync: DatasetSync | null; cron: SyncCronOutcome };

/**
 * Save (or clear) a dataset's scheduled sync — the "Keep this in sync" panel and MCP
 * `set_dataset_sync`. PER-SOURCE MODE/CURSOR LOCKS are enforced HERE, at config time, so neither
 * door can save a schedule that would only fail at run time; then the store's strict gate
 * validates (edit scope, cron, cursor-for-incremental, merge keys) and the SCHEDULE is reconciled
 * (Dagster owns it from `os/schedules.yml`; a pre-B2 CronJob is removed).
 */
export async function saveDatasetSyncService(
  user: Principal,
  datasetId: string,
  sync: DatasetSync | null,
  deps: SaveSyncDeps = {},
): Promise<SaveSyncResult> {
  getDataset(datasetId, user); // view-scope + existence guard first (no leak)
  let platform: string | null = null;
  let next = sync;
  if (next) {
    const mode = String(next.mode ?? '') as DatasetSyncMode;
    if (!DATASET_SYNC_MODES.includes(mode)) fail(`sync \`mode\` must be ${DATASET_SYNC_MODES.join('|')}`, 400, 'mode');
    if (!next.connectionId) fail('a sync needs a `connectionId` (from list_connections)', 400, 'connectionId');
    if (!next.source?.schema || !next.source?.table) fail('a sync needs `source` {schema, table}', 400, 'source');
    const cron = cronFromSchedule(String(next.schedule?.cron ?? ''));
    if (!cron) fail('a sync needs a `schedule` (preset or 5-field cron)', 400, 'schedule');
    // An unresolvable connection is a TYPED refusal before anything is saved: a sync may only
    // be attached to a connection the caller can actually read (the store's 403/404 passes
    // straight through on both doors).
    const resolve = deps.platform ?? ambient.platform ?? livePlatform;
    platform = await resolve(next.connectionId, user);
    let cursor = next.cursor;
    if (platform === 'kafka') {
      if (mode !== 'append') {
        fail(
          'Kafka topics sync append-only (streams have no stable key to merge on; replacing the copy is the reset action, not a mode) — use mode "append"',
          400,
          'mode',
        );
      }
      cursor = { kind: 'kafka-offsets', column: '_partition_offset' }; // tracked automatically
    } else if (platform === 'salesforce') {
      if (mode === 'merge') fail('Salesforce sync supports append or full-refresh only (merge needs a federated SQL source)', 400, 'mode');
      cursor = mode === 'append' ? { kind: 'timestamp', column: 'SystemModstamp' } : undefined; // locked
    } else if (platform === 'kajabi') {
      if (mode === 'merge') fail('Kajabi sync supports append or full-refresh only (merge needs a federated SQL source)', 400, 'mode');
      if (mode === 'append') {
        const field = await kajabiCursorFor(next.source.table, deps);
        if (!field) {
          fail(
            `Kajabi resource '${next.source.table}' documents no timestamp cursor — full-refresh is the only honest sync mode for it (use mode "full-refresh")`,
            400,
            'mode',
          );
        }
        cursor = { kind: 'timestamp', column: field }; // locked to the documented field
      } else {
        cursor = undefined;
      }
    } else if (mode !== 'full-refresh') {
      const column = next.cursor?.column?.trim();
      if (!column) fail(`sync mode '${mode}' needs a \`cursor\` {column, kind: timestamp|number} for this source`, 400, 'cursor');
      cursor = { kind: next.cursor?.kind === 'number' ? 'number' : 'timestamp', column };
    }
    next = {
      connectionId: next.connectionId,
      source: { schema: next.source.schema, table: next.source.table },
      mode,
      ...(cursor ? { cursor } : {}),
      ...(mode === 'merge' ? { mergeKeys: next.mergeKeys ?? [] } : {}),
      schedule: { cron },
      enabled: next.enabled !== false,
    };
  }
  const dataset = setDatasetSync(datasetId, user, next); // the STRICT gate (edit scope + validation)
  const cron = await (deps.reconcile ?? ambient.reconcile ?? reconcileSyncSchedule)(datasetId, dataset.sync ?? null);
  return { datasetId, platform, sync: dataset.sync ?? null, cron };
}

async function kajabiCursorFor(resource: string, deps: SaveSyncDeps): Promise<string | null> {
  const injected = deps.kajabiCursor ?? ambient.kajabiCursor;
  if (injected) return injected(resource);
  const { kajabiCursorField } = await import('@tabs/connections/lib/kajabi-resources');
  return kajabiCursorField(resource) ?? null;
}

/* ------------------------------------------------------------ sync_dataset_now -- */

/**
 * Trigger ONE sync run now — the panel's "Sync now" / "Reset & full re-sync" and MCP
 * `sync_dataset_now`. Edit-gated (the same gate as any structural change), then the SAME
 * executor: with `DATA_PROJECT_GIT` on a Dagster run from the committed head as the dataset
 * OWNER, with it off the OS executor and its ledger row.
 */
export async function syncDatasetNowService(
  user: Principal,
  datasetId: string,
  input: { reset?: boolean } = {},
): Promise<ReturnType<typeof runSyncNow>> {
  getDataset(datasetId, user); // view-scope guard first (typed 403/404 — no leak)
  requireDatasetEditable(datasetId, user); // the manual trigger's edit gate
  return runSyncNow(datasetId, input.reset ? 'reset' : 'manual', user.id);
}
