/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * `describeApp` — the LEGIBILITY surface. A PURE, DOM-free reduction of an AppSpec into a
 * plain-language summary of what each tab shows or does and — the 3.5b extension — the precise
 * app→artifact lineage of each tab: what it SERVES (stories), READS (data/metrics/files/
 * knowledge), WRITES (records/dataset), and USES (agents/connections). This feeds the "How this
 * app works" panel (Phase 4). It NEVER invents behaviour — every field is DERIVED from the spec +
 * the pattern registry, so what the panel says is exactly what the renderer does.
 */
import type { AppSpec, StoryRef, TabBody } from './schema.ts';
import { PATTERNS, summarizePattern } from './patterns.ts';
import { parseExpr } from './expr.ts';
import type { AppFunction } from './functions-schema.ts';
import type {
  ApprovalQueueConfig,
  AssignmentConfig,
  CalendarConfig,
  CardGalleryConfig,
  ChartExplorerConfig,
  DetailConfig,
  KpiOverviewConfig,
  LandingConfig,
  MasterDetailConfig,
  RecordsTableConfig,
  StatusBoardConfig,
  TaskChecklistConfig,
  TimelineConfig,
} from './patterns.ts';

/** One artifact a tab touches: its kind + id (+ optional human label when the spec carries one). */
export type ArtifactRef = { kind: 'dataset' | 'metric' | 'file' | 'knowledge'; id: string };
/** A thing a tab WRITES to. View patterns write nothing; interactive patterns write records. */
export type WriteRef = { kind: 'records'; label: string };
/** A capability a tab USES. Reserved (agents/connections) — patterns don't reference them yet. */
export type UseRef = { kind: 'agent' | 'connection'; id: string };

/** One tab's legibility record. */
export type TabDescription = {
  label: string;
  /** 'view' reads data; 'action' writes through a governed door. Custom blocks are 'custom'. */
  kind: 'view' | 'action' | 'custom';
  /** Plain-language "what this tab shows / does". */
  what: string;
  /** The dataset this tab reads/writes against, if any (else null — e.g. a code block). */
  data: string | null;
  /** The minimum role needed to see the tab, if gated (else null = everyone). */
  roleGate: string | null;
  /** The epics/stories this tab implements (the tab↔story links; empty when none). */
  serves: StoryRef[];
  /** The governed artifacts this tab QUERIES (deduped; empty for a pure write/prose tab). */
  reads: ArtifactRef[];
  /** What this tab MUTATES (view patterns: none; interactive patterns: the app's records). */
  writes: WriteRef[];
  /** Agents/connections this tab invokes (RESERVED — always empty until patterns reference them). */
  uses: UseRef[];
};

/**
 * One backend DSL function's legibility record: its name/description, its kind, and what it READS —
 * an aggregate reads its dataset; an expression reads the OTHER functions it references (`fn.<id>`).
 * This makes "How this app works" explain the app's computed numbers/flags, not just its tabs.
 */
export type FunctionDescription = {
  id: string;
  name: string;
  description: string;
  kind: 'aggregate' | 'expression';
  /** Plain-language "what this function computes". */
  what: string;
  /** The datasets this function queries (an aggregate: its source; an expression: none directly). */
  reads: ArtifactRef[];
  /** The other function ids this function depends on (an expression's `fn.<id>` refs; else empty). */
  dependsOn: string[];
};

export type AppDescription = {
  name: string;
  description: string;
  /** Whether the app applies author theme CSS (a legibility signal — the look is customised). */
  themed: boolean;
  tabs: TabDescription[];
  /** The governed backend DSL functions (3.5d) — empty when the app declares none. */
  functions: FunctionDescription[];
};

/** The dataset a body reads/writes against, if any (the single "primary" source, for `data`). */
function dataSourceOf(body: TabBody): string | null {
  if (body.kind === 'custom') return body.data ? body.data.datasetId : null;
  const cfg = body.config as { source?: { datasetId?: string } };
  return cfg.source?.datasetId ?? null;
}

/** Push a dataset read, deduped by id. */
function addDataset(into: ArtifactRef[], id: string | undefined | null): void {
  if (id && !into.some((r) => r.kind === 'dataset' && r.id === id)) into.push({ kind: 'dataset', id });
}
/** Push a metric read, deduped by id. */
function addMetric(into: ArtifactRef[], id: string | undefined | null): void {
  if (id && !into.some((r) => r.kind === 'metric' && r.id === id)) into.push({ kind: 'metric', id });
}

/**
 * Derive the artifacts a pattern body READS from its config, purely. Every source in the config
 * (dataset sources, metric sources, KPI cards, landing sub-blocks) is enumerated so the lineage
 * edge is exact — demote/delete of any of these warns THIS tab.
 */
function readsOf(body: TabBody): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  if (body.kind === 'custom') {
    addDataset(out, body.data?.datasetId ?? null);
    return out;
  }
  switch (body.pattern) {
    case 'records-table':
    case 'detail':
    case 'status-board':
    case 'master-detail':
    case 'card-gallery':
    case 'timeline':
    case 'calendar': {
      const cfg = body.config as
        | RecordsTableConfig
        | DetailConfig
        | StatusBoardConfig
        | MasterDetailConfig
        | CardGalleryConfig
        | TimelineConfig
        | CalendarConfig;
      addDataset(out, cfg.source.datasetId);
      break;
    }
    case 'chart-explorer': {
      addMetric(out, (body.config as ChartExplorerConfig).metric.metricId);
      break;
    }
    case 'kpi-overview': {
      for (const card of (body.config as KpiOverviewConfig).cards) {
        if (card.metric) addMetric(out, card.metric.metricId);
        else if (card.dataset) addDataset(out, card.dataset.datasetId);
      }
      break;
    }
    case 'landing': {
      for (const block of (body.config as LandingConfig).blocks) {
        if (block.kind === 'table') addDataset(out, block.source.datasetId);
        else if (block.kind === 'kpi') {
          for (const card of block.cards) {
            if (card.metric) addMetric(out, card.metric.metricId);
            else if (card.dataset) addDataset(out, card.dataset.datasetId);
          }
        }
      }
      break;
    }
    // — 3.5c interactive patterns that ALSO read granted datasets to drive their write —
    case 'assignment': {
      const cfg = body.config as AssignmentConfig;
      addDataset(out, cfg.source.datasetId);
      addDataset(out, cfg.assignTo.datasetId);
      break;
    }
    case 'approval-queue':
    case 'task-checklist': {
      const cfg = body.config as ApprovalQueueConfig | TaskChecklistConfig;
      // 'records' means the app's OWN append log (not a governed source); a dataset is a read.
      if (cfg.source !== 'records') addDataset(out, cfg.source.datasetId);
      break;
    }
    // form + intake-wizard (+ reserved interactive patterns) write; they read nothing.
    default:
      break;
  }
  return out;
}

/** Derive what a body WRITES. Only interactive patterns write — to the app's own records. */
function writesOf(body: TabBody): WriteRef[] {
  if (body.kind === 'custom') return [];
  return PATTERNS[body.pattern].category === 'interactive' ? [{ kind: 'records', label: 'app records' }] : [];
}

/** Describe ONE tab body in plain language. */
function describeBody(body: TabBody): { kind: TabDescription['kind']; what: string } {
  if (body.kind === 'custom') {
    const withData = body.data ? ` It is given read-only data from ${body.data.datasetId}.` : '';
    return { kind: 'custom', what: `A custom, sandboxed html/css/js block.${withData}` };
  }
  const def = PATTERNS[body.pattern];
  const kind: TabDescription['kind'] = def.category === 'interactive' ? 'action' : 'view';
  return { kind, what: summarizePattern(body.pattern, body.config) };
}

/** Describe ONE backend DSL function purely: what it computes + what it reads/depends on. */
function describeFunction(fn: AppFunction): FunctionDescription {
  if (fn.kind === 'aggregate') {
    const filtered = fn.filters && fn.filters.length > 0 ? ` (filtered by ${fn.filters.map((f) => f.field).join(', ')})` : '';
    const over = fn.op === 'count' ? '' : ` of ${fn.field}`;
    return {
      id: fn.id,
      name: fn.name,
      description: fn.description,
      kind: 'aggregate',
      what: `Computes the ${fn.op}${over} over ${fn.source.datasetId}${filtered}.`,
      reads: [{ kind: 'dataset', id: fn.source.datasetId }],
      dependsOn: [],
    };
  }
  const parsed = parseExpr(fn.expr);
  const refs = parsed.ok ? parsed.refs : [];
  const on = refs.length > 0 ? ` using ${refs.map((r) => `fn.${r}`).join(', ')}` : '';
  return {
    id: fn.id,
    name: fn.name,
    description: fn.description,
    kind: 'expression',
    what: `Evaluates \`${fn.expr}\`${on}.`,
    reads: [],
    dependsOn: refs,
  };
}

/**
 * Reduce a spec to its legibility description. Pure and total: preserves tab order and reports
 * every tab (gated ones included — the panel is the honest "what this app does" map, not a
 * per-viewer filter; the renderer applies role gating separately).
 */
export function describeApp(spec: AppSpec): AppDescription {
  return {
    name: spec.name,
    description: spec.description,
    themed: !!spec.theme?.css,
    functions: (spec.functions ?? []).map(describeFunction),
    tabs: spec.tabs.map((t) => {
      const { kind, what } = describeBody(t.body);
      return {
        label: t.label,
        kind,
        what,
        data: dataSourceOf(t.body),
        roleGate: t.roleGate ?? null,
        serves: t.stories ?? [],
        reads: readsOf(t.body),
        writes: writesOf(t.body),
        uses: [], // RESERVED — patterns don't reference agents/connections yet (3.5c+).
      };
    }),
  };
}
