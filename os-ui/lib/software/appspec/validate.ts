/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { peekDatasetMeta, peekDatasetTier, peekDatasetColumns, getDataset, type Principal } from '@/lib/data/store';
import { peekMetricExists, getMetric } from '@/lib/metrics/store';
import { getSystem } from '@/lib/agents/store';
import { isPersonalDataGrantRisk, PERSONAL_DATA_GRANT_WARNING } from '@/lib/software/grant-granularity';
import type { App } from '@/lib/software/apps';
import { ROLE_GATES } from './schema.ts';
import type { AppSpec, CustomBody, RoleGate, SpecIssue, StoryRef, Tab } from './schema.ts';
import type {
  ApprovalQueueConfig,
  AssignmentConfig,
  CalendarConfig,
  CardGalleryConfig,
  ChartExplorerConfig,
  DetailConfig,
  FormConfig,
  IntakeWizardConfig,
  KpiCard,
  KpiOverviewConfig,
  LandingConfig,
  MasterDetailConfig,
  RecordsTableConfig,
  StatusBoardConfig,
  TaskChecklistConfig,
  TimelineConfig,
} from './patterns.ts';
import { PATTERNS } from './patterns.ts';
import type { AppFunction } from './functions-schema.ts';
import { parseExpr } from './expr.ts';

/**
 * Author-time SEMANTIC validation for a declarative AppSpec (v2 — tabs·patterns·custom) — the
 * invariants from DESIGN.md, checked against the REAL stores AFTER a successful structural
 * `parseAppSpec`. It is the gate that makes a declarative app trivially self-correcting: every
 * reference (dataset, column) is proven to exist and be granted, or a typed `{path,reason,fix}`
 * issue names the exact fix — no runtime `Forbidden: … not granted` and no false "deleted".
 *
 * Pattern configs are validated per-pattern against the dataset's real schema (fields exist,
 * source granted) exactly like the v1 views were. Custom blocks are validated for their
 * (optional) injected-data grant. Metric-backed patterns are coming-soon this phase, so there
 * is no metric check yet (added when those patterns land).
 *
 * `issues` BLOCK (the spec must not save); `warnings` ALLOW (save with a caveat, e.g. a
 * Personal owner-only dataset that other app users can't read). EVERY store lookup is
 * FAIL-SOFT: a thrown/unavailable peek SKIPS that check with a benign note rather than
 * emitting a false "invalid" — a transient store blip must never reject a good spec.
 */

export type SpecWarning = { path: string; reason: string; fix: string };

type Ctx = {
  issues: SpecIssue[];
  warnings: SpecWarning[];
  grantedData: Set<string>;
  grantedMetrics: Set<string>;
  /** epicId → set of storyIds, from the app's designed epics (for tab↔story validation). */
  stories: Map<string, Set<string>>;
  /** The set of declared function ids (for kpi function-card refs + expr `fn.<id>` refs). */
  functionIds: Set<string>;
};

function issue(ctx: Ctx, path: string, reason: string, fix: string): void {
  ctx.issues.push({ path, reason, fix });
}
function warn(ctx: Ctx, path: string, reason: string, fix: string): void {
  ctx.warnings.push({ path, reason, fix });
}

/** Non-throwing wrapper: run a peek; on any throw return the fail-soft sentinel. */
function soft<T>(fn: () => T, onFail: T): T {
  try {
    return fn();
  } catch {
    return onFail;
  }
}

/**
 * Defense-in-depth (M2): a bound grant id (dataset / metric / agent) must be one the AUTHOR is
 * entitled to VIEW. Runtime already re-enforces per-viewer RLS on every read, so this can ONLY
 * ever add a DENY — never widen access — but it turns a silently-bound "ghost" grant (an id the
 * author can't actually see) into a legible author-time issue instead of a dead runtime 403.
 *
 * `read` runs the SAME governed reader the UI uses (it throws 403 when not entitled, 404 when the
 * id is absent). A 403 → surface the issue; a 404 is left to the existing existence checks
 * (dataset/metric) except for agents, which have no other existence check here. ANY OTHER throw is
 * FAIL-SOFT (store blip) — a transient error must never emit a false "not entitled".
 */
function assertEntitled(
  ctx: Ctx,
  user: Principal,
  kind: 'dataset' | 'metric' | 'agent',
  id: string,
  read: () => unknown,
): void {
  try {
    read();
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403 || (kind === 'agent' && status === 404)) {
      issue(
        ctx,
        `grants.${kind === 'dataset' ? 'data' : kind === 'metric' ? 'metrics' : 'agents'}`,
        `you are not entitled to the granted ${kind} ${id}`,
        `remove it, or ask its owner for access — an app can only bind ${kind}s you can view`,
      );
    }
    // any other status (404 for dataset/metric, or an unknown store error) is fail-soft: the
    // existence checks own the "does not exist" message; a transient blip must not false-deny.
  }
}

/**
 * Validate ONE dataset source: EXISTS (peek), GRANTED (app.grants.data), Personal-warning,
 * and every referenced field against the dataset's real columns. Shared by every dataset-backed
 * pattern. Column checks list the REAL columns in the fix — the highest-value teaching signal.
 */
function checkDatasetSource(
  ctx: Ctx,
  datasetId: string,
  sourcePath: string,
  fields: { field: string; path: string }[],
): void {
  // EXISTS — peekDatasetMeta returns null ONLY for a truly-absent id (archived still exists).
  // A THROW is fail-soft (store unavailable) → skip existence + downstream checks.
  const meta = soft(() => peekDatasetMeta(datasetId), undefined);
  if (meta === undefined) return; // store unavailable — skip silently (no false "invalid")
  if (meta === null) {
    issue(ctx, sourcePath, `dataset ${datasetId} does not exist`, 'pick an existing dataset or restore it');
    return; // no point checking grant/columns on a missing dataset
  }

  // GRANTED — must be in app.grants.data (mirrors dataset-guard's ungranted logic).
  if (!ctx.grantedData.has(datasetId)) {
    issue(ctx, sourcePath, `dataset ${datasetId} is not granted to this app`, 'grant it in Context');
  }

  // PERSONAL owner-only WARNING — same class as the 0.6.115 personal-grant warning.
  const tier = soft(() => peekDatasetTier(datasetId), null);
  if (tier !== null) {
    const scope = tier === 'dataset' ? 'personal' : tier === 'asset' ? 'domain' : 'marketplace';
    if (isPersonalDataGrantRisk('data', scope)) {
      warn(ctx, sourcePath, PERSONAL_DATA_GRANT_WARNING, 'promote it to Domain in the Data tab');
    }
  }

  // COLUMNS — every referenced field must exist in the dataset's real column set.
  const cols = soft(() => peekDatasetColumns(datasetId), null);
  if (cols === null) return; // undocumented / unavailable columns — skip (soft)
  const colSet = new Set(cols);
  for (const f of fields) {
    if (!colSet.has(f.field)) {
      issue(ctx, f.path, `column ${f.field} not in dataset ${datasetId}`, `use one of: ${cols.join(', ')}`);
    }
  }
}

/**
 * Validate ONE metric source: EXISTS (unscoped `peekMetricExists` — a metric is a measure on a
 * dataset) and GRANTED (app.grants.metrics). Fail-soft on a thrown peek. Shared by the two
 * metric-backed view patterns (`kpi-overview` cards, `chart-explorer`).
 */
function checkMetricSource(ctx: Ctx, metricId: string, path: string): void {
  const exists = soft(() => peekMetricExists(metricId), null);
  if (exists === null) return; // store unavailable — skip silently
  if (!exists) {
    issue(ctx, path, `metric ${metricId} does not exist`, 'pick an existing metric (dataset.measure)');
    return;
  }
  if (!ctx.grantedMetrics.has(metricId)) {
    issue(ctx, path, `metric ${metricId} is not granted to this app`, 'grant it in Context');
  }
}

// ------------------------------------------------------------ per-pattern semantic checks --

function checkRecordsTable(ctx: Ctx, cfg: RecordsTableConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    ...cfg.columns.map((c, i) => ({ field: c.field, path: `${path}.columns[${i}].field` })),
    ...(cfg.filters ?? []).map((f, i) => ({ field: f.field, path: `${path}.filters[${i}].field` })),
    ...(cfg.sort !== undefined ? [{ field: cfg.sort, path: `${path}.sort` }] : []),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

function checkDetail(ctx: Ctx, cfg: DetailConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    { field: cfg.keyField, path: `${path}.keyField` },
    ...cfg.fields.map((f, i) => ({ field: f.field, path: `${path}.fields[${i}].field` })),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

function checkStatusBoard(ctx: Ctx, cfg: StatusBoardConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    { field: cfg.statusField, path: `${path}.statusField` },
    { field: cfg.titleField, path: `${path}.titleField` },
    ...(cfg.subtitleFields ?? []).map((f, i) => ({ field: f, path: `${path}.subtitleFields[${i}]` })),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

/** An intake wizard WRITES (os.records) — its target is the app's own records, NOT a dataset,
 *  so there is no dataset source to validate. Field names are free (the app owns its schema). */
function checkIntakeWizard(_ctx: Ctx, _cfg: IntakeWizardConfig, _path: string): void {
  /* nothing to validate against the stores — the write door is envelope-gated at runtime. */
}

// — 3.5b VIEW patterns —

function checkMasterDetail(ctx: Ctx, cfg: MasterDetailConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    { field: cfg.keyField, path: `${path}.keyField` },
    ...cfg.listColumns.map((c, i) => ({ field: c.field, path: `${path}.listColumns[${i}].field` })),
    ...cfg.detailFields.map((f, i) => ({ field: f.field, path: `${path}.detailFields[${i}].field` })),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

/** A KPI card is metric-backed, dataset-aggregate-backed, or function-backed — check its source. */
function checkKpiCard(ctx: Ctx, card: KpiCard, path: string): void {
  if (card.metric) {
    checkMetricSource(ctx, card.metric.metricId, `${path}.metric.metricId`);
  } else if (card.dataset) {
    const fields =
      card.dataset.field !== undefined
        ? [{ field: card.dataset.field, path: `${path}.dataset.field` }]
        : [];
    checkDatasetSource(ctx, card.dataset.datasetId, `${path}.dataset.datasetId`, fields);
  } else if (card.function) {
    // The referenced function must be DECLARED in the spec's functions[].
    if (!ctx.functionIds.has(card.function.functionId)) {
      issue(
        ctx,
        `${path}.function.functionId`,
        `function ${card.function.functionId} is not declared`,
        ctx.functionIds.size > 0
          ? `use one of: ${[...ctx.functionIds].join(', ')}`
          : 'declare it in the spec functions[]',
      );
    }
  }
}

function checkKpiOverview(ctx: Ctx, cfg: KpiOverviewConfig, path: string): void {
  cfg.cards.forEach((card, i) => checkKpiCard(ctx, card, `${path}.cards[${i}]`));
}

function checkChartExplorer(ctx: Ctx, cfg: ChartExplorerConfig, path: string): void {
  checkMetricSource(ctx, cfg.metric.metricId, `${path}.metric.metricId`);
}

function checkCardGallery(ctx: Ctx, cfg: CardGalleryConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    { field: cfg.titleField, path: `${path}.titleField` },
    ...(cfg.subtitleField !== undefined ? [{ field: cfg.subtitleField, path: `${path}.subtitleField` }] : []),
    ...(cfg.fields ?? []).map((c, i) => ({ field: c.field, path: `${path}.fields[${i}].field` })),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

function checkTimeline(ctx: Ctx, cfg: TimelineConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    { field: cfg.dateField, path: `${path}.dateField` },
    { field: cfg.titleField, path: `${path}.titleField` },
    ...(cfg.descriptionField !== undefined ? [{ field: cfg.descriptionField, path: `${path}.descriptionField` }] : []),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

function checkCalendar(ctx: Ctx, cfg: CalendarConfig, path: string): void {
  const fields: { field: string; path: string }[] = [
    { field: cfg.dateField, path: `${path}.dateField` },
    { field: cfg.titleField, path: `${path}.titleField` },
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

// — 3.5c INTERACTIVE patterns —

/** A `form` WRITES (os.records) — its `fields` name the app's OWN record schema (free), so there
 *  is no dataset source to validate. The write door is envelope-gated at runtime. */
function checkForm(_ctx: Ctx, _cfg: FormConfig, _path: string): void {
  /* nothing to validate against the stores — same as intake-wizard. */
}

/**
 * `assignment` reads TWO granted datasets: `source` (the items, labelled by `itemLabelField`) and
 * `assignTo` (the assignees, labelled by `optionLabelField`). Both must exist, be granted, and
 * carry their label column. The APPEND itself is envelope-gated at runtime (no dataset to validate).
 */
function checkAssignment(ctx: Ctx, cfg: AssignmentConfig, path: string): void {
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, [
    { field: cfg.itemLabelField, path: `${path}.itemLabelField` },
  ]);
  checkDatasetSource(ctx, cfg.assignTo.datasetId, `${path}.assignTo.datasetId`, [
    { field: cfg.assignTo.optionLabelField, path: `${path}.assignTo.optionLabelField` },
  ]);
}

/**
 * `approval-queue` / `task-checklist` read from EITHER the app's own `records` (nothing to validate
 * against the stores — the app owns that schema) OR a granted dataset (validate existence/grant +
 * that the title/subtitle/assignee columns exist). The decision/completion append is envelope-gated.
 */
function checkApprovalQueue(ctx: Ctx, cfg: ApprovalQueueConfig, path: string): void {
  if (cfg.source === 'records') return; // app's own append log — no dataset to validate
  const fields: { field: string; path: string }[] = [
    { field: cfg.titleField, path: `${path}.titleField` },
    ...(cfg.subtitleFields ?? []).map((f, i) => ({ field: f, path: `${path}.subtitleFields[${i}]` })),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

function checkTaskChecklist(ctx: Ctx, cfg: TaskChecklistConfig, path: string): void {
  if (cfg.source === 'records') return; // app's own append log — no dataset to validate
  const fields: { field: string; path: string }[] = [
    { field: cfg.titleField, path: `${path}.titleField` },
    ...(cfg.assigneeField !== undefined ? [{ field: cfg.assigneeField, path: `${path}.assigneeField` }] : []),
  ];
  checkDatasetSource(ctx, cfg.source.datasetId, `${path}.source.datasetId`, fields);
}

function checkLanding(ctx: Ctx, cfg: LandingConfig, path: string): void {
  cfg.blocks.forEach((block, i) => {
    const bp = `${path}.blocks[${i}]`;
    if (block.kind === 'kpi') {
      block.cards.forEach((card, j) => checkKpiCard(ctx, card, `${bp}.cards[${j}]`));
    } else if (block.kind === 'table') {
      const fields = block.columns.map((c, j) => ({ field: c.field, path: `${bp}.columns[${j}].field` }));
      checkDatasetSource(ctx, block.source.datasetId, `${bp}.source.datasetId`, fields);
    }
    // markdown blocks reference no stores.
  });
}

function checkPatternBody(ctx: Ctx, tab: Tab, path: string): void {
  if (tab.body.kind !== 'pattern') return;
  const { pattern, config } = tab.body;
  const bp = `${path}.body.config`;
  switch (pattern) {
    case 'records-table':
      checkRecordsTable(ctx, config as RecordsTableConfig, bp);
      break;
    case 'detail':
      checkDetail(ctx, config as DetailConfig, bp);
      break;
    case 'status-board':
      checkStatusBoard(ctx, config as StatusBoardConfig, bp);
      break;
    case 'intake-wizard':
      checkIntakeWizard(ctx, config as IntakeWizardConfig, bp);
      break;
    case 'master-detail':
      checkMasterDetail(ctx, config as MasterDetailConfig, bp);
      break;
    case 'kpi-overview':
      checkKpiOverview(ctx, config as KpiOverviewConfig, bp);
      break;
    case 'chart-explorer':
      checkChartExplorer(ctx, config as ChartExplorerConfig, bp);
      break;
    case 'card-gallery':
      checkCardGallery(ctx, config as CardGalleryConfig, bp);
      break;
    case 'timeline':
      checkTimeline(ctx, config as TimelineConfig, bp);
      break;
    case 'calendar':
      checkCalendar(ctx, config as CalendarConfig, bp);
      break;
    case 'landing':
      checkLanding(ctx, config as LandingConfig, bp);
      break;
    case 'form':
      checkForm(ctx, config as FormConfig, bp);
      break;
    case 'assignment':
      checkAssignment(ctx, config as AssignmentConfig, bp);
      break;
    case 'approval-queue':
      checkApprovalQueue(ctx, config as ApprovalQueueConfig, bp);
      break;
    case 'task-checklist':
      checkTaskChecklist(ctx, config as TaskChecklistConfig, bp);
      break;
    default:
      // Coming-soon patterns carry an opaque config with no store references to validate yet.
      // Their phase adds the real semantic checks alongside their renderer.
      break;
  }
}

/** A custom block's OPTIONAL injected data must reference an existing, GRANTED dataset. */
function checkCustomBody(ctx: Ctx, body: CustomBody, path: string): void {
  if (!body.data) return;
  checkDatasetSource(ctx, body.data.datasetId, `${path}.body.data.datasetId`, []);
}

function validRoleGate(roleGate: RoleGate): boolean {
  return (ROLE_GATES as readonly string[]).includes(roleGate);
}

/**
 * Validate a tab's OPTIONAL story refs against the app's DESIGNED epics/stories. An unknown
 * epic (or a story not under its named epic) is a blocking issue — this is the Design→Build
 * bridge, so a dangling link must be caught. Many-to-many is allowed (no cross-tab uniqueness).
 * When the app has NO epics designed yet, any ref is unknown (there is nothing to link to).
 */
function checkStories(ctx: Ctx, stories: StoryRef[], path: string): void {
  stories.forEach((ref, i) => {
    const sp = `${path}[${i}]`;
    const epicStories = ctx.stories.get(ref.epicId);
    if (!epicStories) {
      issue(ctx, `${sp}.epicId`, `epic ${ref.epicId} is not a designed epic of this app`, 'link to an existing epic (Design stage)');
      return;
    }
    if (!epicStories.has(ref.storyId)) {
      issue(ctx, `${sp}.storyId`, `story ${ref.storyId} is not under epic ${ref.epicId}`, 'link to an existing story under this epic');
    }
  });
}

/**
 * Validate the app's backend DSL `functions[]` (3.5d):
 *  • ids are UNIQUE across all functions.
 *  • aggregate: source dataset EXISTS + is GRANTED; the `field` exists in the dataset's real
 *    columns (numeric-op already required a field structurally); each filter field exists.
 *  • expression: parses (structural parser already caught syntax) AND every `fn.<id>` reference
 *    resolves to a declared function id; NO cycles (a function referencing itself transitively).
 * All checks are fail-soft against the stores (a store blip skips existence/column checks, never
 * emits a false "invalid").
 */
function checkFunctions(ctx: Ctx, functions: AppFunction[]): void {
  const byId = new Map<string, AppFunction>();

  // id uniqueness (report each duplicate at its own index).
  const seen = new Set<string>();
  functions.forEach((fn, i) => {
    if (seen.has(fn.id)) {
      issue(ctx, `functions[${i}].id`, `duplicate function id "${fn.id}"`, 'give each function a unique id');
    }
    seen.add(fn.id);
    if (!byId.has(fn.id)) byId.set(fn.id, fn);
  });

  // per-function structural-semantic checks.
  functions.forEach((fn, i) => {
    const p = `functions[${i}]`;
    if (fn.kind === 'aggregate') {
      const fields: { field: string; path: string }[] = [
        ...(fn.field !== undefined ? [{ field: fn.field, path: `${p}.field` }] : []),
        ...(fn.filters ?? []).map((f, j) => ({ field: f.field, path: `${p}.filters[${j}].field` })),
      ];
      checkDatasetSource(ctx, fn.source.datasetId, `${p}.source.datasetId`, fields);
    } else {
      // expression: re-parse to enumerate refs (structural parse already guaranteed it parses).
      const parsed = parseExpr(fn.expr);
      if (parsed.ok) {
        for (const ref of parsed.refs) {
          if (!byId.has(ref)) {
            issue(ctx, `${p}.expr`, `expression references unknown function fn.${ref}`, `reference a declared function id (one of: ${[...byId.keys()].join(', ') || 'none'})`);
          }
        }
      }
    }
  });

  // cycle detection over expression → fn.<id> edges (aggregates are leaves).
  const state = new Map<string, 'visiting' | 'done'>();
  const refsOf = (id: string): string[] => {
    const fn = byId.get(id);
    if (!fn || fn.kind !== 'expression') return [];
    const parsed = parseExpr(fn.expr);
    return parsed.ok ? parsed.refs.filter((r) => byId.has(r)) : [];
  };
  let reportedCycle = false;
  const dfs = (id: string): boolean => {
    const st = state.get(id);
    if (st === 'done') return false;
    if (st === 'visiting') return true; // back-edge → cycle
    state.set(id, 'visiting');
    let cyclic = false;
    for (const ref of refsOf(id)) if (dfs(ref)) cyclic = true;
    state.set(id, 'done');
    return cyclic;
  };
  functions.forEach((fn, i) => {
    if (fn.kind !== 'expression' || reportedCycle) return;
    // Fresh visit tracking per root is unnecessary; a single shared pass finds any cycle.
    if (dfs(fn.id)) {
      issue(ctx, `functions[${i}].expr`, `function ${fn.id} is part of a reference cycle`, 'break the fn.<id> cycle (functions must form a DAG)');
      reportedCycle = true;
    }
  });
}

function checkTab(ctx: Ctx, tab: Tab, path: string): void {
  // roleGate must be a valid ladder rung (the parser already enforces the enum; this is the
  // semantic belt-and-braces the invariant list calls for).
  if (tab.roleGate !== undefined && !validRoleGate(tab.roleGate)) {
    issue(ctx, `${path}.roleGate`, `roleGate ${tab.roleGate} is not a valid role`, `use one of: ${ROLE_GATES.join(', ')}`);
  }

  if (tab.stories !== undefined) checkStories(ctx, tab.stories, `${path}.stories`);

  if (tab.body.kind === 'pattern') checkPatternBody(ctx, tab, path);
  else checkCustomBody(ctx, tab.body, path);
}

/**
 * Run every author-time invariant over a STRUCTURALLY-VALID spec (call after `parseAppSpec`
 * succeeds). The existence/column peeks are deliberately UNSCOPED (existence is not per-viewer)
 * so a real 403 at runtime is pre-empted here, not masked. `user` IS used for a defense-in-depth
 * entitlement pass over the app's bound grants (M2) — a check that can only ever DENY.
 */
export async function validateAppSpec(
  app: App,
  spec: AppSpec,
  user: Principal,
): Promise<{ issues: SpecIssue[]; warnings: SpecWarning[] }> {
  // The app's designed epics/stories (epicId → storyIds), for tab↔story validation. Defensive
  // against a pre-Design app whose `epics` is absent (older records default to []).
  const stories = new Map<string, Set<string>>();
  for (const epic of app.epics ?? []) {
    stories.set(epic.id, new Set((epic.stories ?? []).map((s) => s.id)));
  }

  const ctx: Ctx = {
    issues: [],
    warnings: [],
    grantedData: new Set(app.grants.data.map((g) => g.id)),
    grantedMetrics: new Set((app.grants.metrics ?? []).map((g) => g.id)),
    stories,
    functionIds: new Set((spec.functions ?? []).map((f) => f.id)),
  };

  // DEFENSE-IN-DEPTH (M2): every id BOUND to the app (dataset / metric / agent) must be viewable
  // by the author. Runtime re-enforces viewer RLS, so this only ever DENIES — it can't widen
  // access — but it surfaces a ghost grant (an id the author can't see) as a clear author-time
  // issue instead of a dead 403 at run time. `user` is finally used here.
  for (const g of app.grants.data) assertEntitled(ctx, user, 'dataset', g.id, () => getDataset(g.id, user));
  for (const g of app.grants.metrics ?? []) assertEntitled(ctx, user, 'metric', g.id, () => getMetric(g.id, user));
  for (const g of app.agents ?? []) assertEntitled(ctx, user, 'agent', g.id, () => getSystem(g.id, user));

  // Backend DSL functions (3.5d): ids unique, aggregate sources granted + fields exist, expression
  // refs resolve + no cycles. Checked FIRST so kpi function-card refs see the declared id set.
  if (spec.functions && spec.functions.length > 0) checkFunctions(ctx, spec.functions);

  // Tab ids must be unique.
  const seen = new Set<string>();
  spec.tabs.forEach((t, i) => {
    if (seen.has(t.id)) {
      issue(ctx, `tabs[${i}].id`, `duplicate tab id "${t.id}"`, 'give each tab a unique id');
    }
    seen.add(t.id);
    checkTab(ctx, t, `tabs[${i}]`);
  });

  // A referenced pattern must be a real registry entry (belt-and-braces; the parser's enum
  // already guarantees this — this asserts the registry stays in lockstep with the enum).
  spec.tabs.forEach((t, i) => {
    if (t.body.kind === 'pattern' && !PATTERNS[t.body.pattern]) {
      issue(ctx, `tabs[${i}].body.pattern`, `unknown pattern "${t.body.pattern}"`, 'use a known pattern id');
    }
  });

  return { issues: ctx.issues, warnings: ctx.warnings };
}
