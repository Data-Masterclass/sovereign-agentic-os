/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric builder — create a metric in Edit, inspect an existing one in View
 * USER STORY: As a creator I want one screen to define, preview, save and then govern a metric
 *             so that a metric goes from idea to promoted without switching tools.
 * ARCHITECTURE:
 *   - Client component opened by `MetricsTab`; a new metric opens in Edit, an existing one in
 *     View (definition, governed SQL, preview, explore, alerts, dashboards that use it).
 *   - Talks to `/api/metrics/preview`, `/api/metrics/define`, `/api/metrics/{id}` (+ promote /
 *     demote) and reads datasets from `/api/data/datasets`.
 *   - Composite formulas are validated client-side with `compileFormula` / `assertFormulaRefs`
 *     from `@tabs/metrics/lib/formula`; `lib/model.ts` checks them again server-side.
 *   - Lifecycle actions reuse the shared core pieces (PromoteButton, DemoteButton,
 *     LifecycleActions, ConfirmProvider).
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useServerMessage } from '@core/i18n/client';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { canManageArtifact } from '@core/policy/edit-scope';
import { ConfirmProvider } from '@core/ui/lifecycle/ConfirmDialog';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@core/ui/lifecycle/PromoteButton';
import DemoteButton from '@core/ui/lifecycle/DemoteButton';
import type { Visibility } from '@core/kernel/lifecycle';
import { visibilityForTier } from '@core/kernel/artifact-model';
import DomainTag from '@core/ui/DomainTag';
import { useToast } from '@core/ui/core/Toast';
import BuilderModeToggle from '@core/ui/core/BuilderModeToggle';
import type { ViewMode } from '@core/kernel/view-mode';
import BusyProgress from '@core/ui/core/BusyProgress';
import MetricStageAssistant from '@tabs/metrics/ui/MetricStageAssistant';
import ExploreMetric from '@tabs/metrics/ui/ExploreMetric';
import Alerts from '@tabs/metrics/ui/Alerts';
import { formFromMeasure, type MetricForm } from '@tabs/metrics/lib/model';
import { compileFormula, assertFormulaRefs, FormulaError } from '@tabs/metrics/lib/formula';
import type { MetricKind } from '@tabs/metrics/ui/MetricTypeChooser';
import {
  type DatasetGroups,
  type DatasetTile,
  type DefineResult,
  type MetricGroups,
  type MetricSummary,
  TIER_BADGE,
  TierWord,
  useDatasetLayerLabel,
} from '@tabs/metrics/ui/shared';
import { UnderTheHood } from '@core/ui/engineering/UnderTheHood';
import { TechnicalDetailsOnly } from '@core/ui/TechnicalDetails';
import GitHeadBadge from '@core/ui/git/GitHeadBadge';
import CloneRepository from '@core/ui/git-clone/CloneRepository';

const METRIC_MODE_KEY = 'metrics.viewMode';

type MetricsT = ReturnType<typeof useTranslations<'metrics'>>;

/* ─────────────────────────────── constants ─────────────────────────────── */

// The SIMPLE-path aggregations. The composite 'formula' path is NO LONGER an entry here —
// the type chooser (Simple vs Complex) owns that decision, so nobody has to hunt a buried
// dropdown item to reach a composite metric.
// `key` names the label + hint in `metrics.builder.agg.<key>`.
const AGGREGATIONS = [
  { value: 'count', key: 'count' },
  { value: 'sum', key: 'sum' },
  { value: 'avg', key: 'avg' },
  { value: 'count_distinct', key: 'countDistinct' },
  { value: 'count_distinct_approx', key: 'countDistinctApprox' },
  { value: 'min', key: 'min' },
  { value: 'max', key: 'max' },
  { value: 'number', key: 'ratio' },
] as const;

// Labels in `metrics.builder.op.<value>`.
const OPERATORS = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'set', 'notSet'] as const;
const isOperator = (v: string): v is (typeof OPERATORS)[number] => (OPERATORS as readonly string[]).includes(v);

const WINDOW_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
// Labels in `metrics.builder.format.<key>`.
const FORMATS = [
  { value: '', key: 'plain' },
  { value: 'currency', key: 'currency' },
  { value: 'percent', key: 'percent' },
  { value: 'number', key: 'number' },
] as const;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;

type WindowMode = 'none' | 'running' | 'trailing';

type Form = {
  name: string;
  /** Plain-language "what does this metric mean?" — a one-to-two-line note authored up front. */
  description: string;
  aggregation: string;
  column: string;
  dimensions: string[];
  filter: { on: boolean; column: string; operator: string; value: string };
  windowMode: WindowMode;
  windowAmount: number;
  windowUnit: (typeof WINDOW_UNITS)[number];
  ratio: { numerator: string; denominator: string };
  /** Composite formula over other metrics (UI aggregation 'formula' → payload 'number'). */
  formula: string;
  format: string;
  timeDimension: string;
  granularity: (typeof GRAINS)[number];
};

const EMPTY_FORM: Form = {
  name: '',
  description: '',
  aggregation: 'sum',
  column: '',
  dimensions: [],
  filter: { on: false, column: '', operator: 'equals', value: '' },
  windowMode: 'none',
  windowAmount: 7,
  windowUnit: 'day',
  ratio: { numerator: '', denominator: '' },
  formula: '',
  format: '',
  timeDimension: '',
  granularity: 'month',
};

type Column = { name: string; description?: string };
type Measure = { name: string; type: string };

type PreviewResult = {
  member: string;
  rows: Record<string, unknown>[];
  /** 'live (sql)' = pre-save preview computed via governed SQL (not yet Cube-served). */
  mode: 'live' | 'live (sql)' | 'offline-mock';
  pending?: boolean;
  /** LOUD degradation notice: requested slice members not exposed on the governed view
   *  were dropped — the preview is NOT sliced as asked (never a silent de-dimension). */
  warning?: string;
  /** The governed Trino SQL the number came from — View's "how it is calculated". */
  sql?: string;
};

/** Metric tier → lifecycle visibility (drives delete gate) — OS-wide mapping. */
const lcVis = (tier: MetricSummary['tier']): Visibility => visibilityForTier(tier);
/** Metric tier → the PromoteButton's ladder tier. */
const ladderTier = (tier: MetricSummary['tier']): PromoteTier =>
  tier === 'domain' ? 'Shared' : tier === 'marketplace' ? 'Marketplace' : 'Personal';

/* ─────────────────────────── sub-hooks ─────────────────────────────────── */

/** The chosen dataset's governed detail — columns (with docs), measures, description and
 *  deliverability — from the SAME per-dataset fetch the picker's warning uses. `columnDocs`
 *  + `description` + `measures` feed the Define assistant (P0-3) so its proposal is grounded
 *  in the real, documented schema, not just bare column names. */
type DatasetDetail = {
  columns: string[];
  columnDocs: Column[];
  measures: Measure[];
  description: string;
  deliverable: boolean;
  /** The dataset's governed layer/tier (e.g. 'asset', 'product', 'dataset') — feeds View's
   *  "data underneath" section via {@link datasetLayerLabel}. */
  tier: string;
};
const EMPTY_DETAIL: DatasetDetail = { columns: [], columnDocs: [], measures: [], description: '', deliverable: true, tier: '' };

function useDataset(datasetId: string): DatasetDetail {
  const [state, setState] = useState<DatasetDetail>(EMPTY_DETAIL);
  useEffect(() => {
    if (!datasetId) { setState(EMPTY_DETAIL); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
        const data = await res.json();
        if (live && res.ok) {
          const ds = data?.dataset ?? {};
          // Prefer `goldColumns` — the ACTUAL columns of the built gold table (join
          // output names). `columns` documents the base/Silver schema, which diverges
          // after a Gold join (joined columns added, unprojected ones gone).
          let cols = ((ds.goldColumns?.length ? ds.goldColumns : ds.columns) ?? []) as Column[];
          // UNDOCUMENTED dataset fallback: no documented columns at all left the AI
          // button dead with no way forward. The governed row preview knows the REAL
          // columns of the built table — use their names (no docs, honestly bare).
          if (cols.length === 0 && ds?.versions?.gold?.built) {
            try {
              const p = await fetch(`/api/data/datasets/${datasetId}/preview?limit=1`, { cache: 'no-store' });
              const pd = await p.json();
              if (p.ok && pd?.available) cols = (pd.columns as string[]).map((name) => ({ name }));
            } catch { /* preview unreachable → stay with the documented (empty) set */ }
          }
          const ms = (ds.measures ?? []) as Measure[];
          // SERVABLE = a built Gold, of ANY tier. Since the metrics→Trino migration a
          // metric serves as governed SQL over the physical gold mart read AS the viewer
          // (metricSqlReady, lib/data/metrics.ts) — a PERSONAL dataset with built Gold
          // serves metrics with no promotion. The only thing that blocks defining a metric
          // is an UNBUILT Gold. (Cube semantic-layer registration additionally needs a
          // governed tier — metricModelReady — but that's the dashboards path, not serving.)
          const deliverable = Boolean(ds?.versions?.gold?.built);
          if (!live) return;
          setState({
            columns: cols.map((c) => c.name).filter(Boolean),
            columnDocs: cols.filter((c) => c.name),
            measures: ms,
            description: typeof ds.description === 'string' ? ds.description : '',
            deliverable,
            tier: typeof ds.tier === 'string' ? ds.tier : '',
          });
        }
      } catch { if (live) setState(EMPTY_DETAIL); }
    })();
    return () => { live = false; };
  }, [datasetId]);
  return state;
}

/* ─────────────────────────── small pieces ──────────────────────────────── */

/**
 * The grouped dataset picker — My · Domain · Company, each option layer-badged with a
 * TOLERANT label ({@link datasetLayerLabel}, so a future "curated" kind can't break it).
 * The deliverability warning lives IN the picker (right under the select) so the user
 * learns a dataset isn't Gold-served BEFORE they invest in the form — not after Publish.
 * Deliverability for the SELECTED dataset comes from the parent's governed per-dataset
 * fetch (`useDataset`), so tiles stay untouched (no extra field on the list payload).
 */
function DatasetPicker({
  value,
  onChange,
  selectedDeliverable,
}: {
  value: string;
  onChange: (id: string) => void;
  /** The chosen dataset's deliverability, from the parent lazy fetch (null = unknown yet). */
  selectedDeliverable: boolean | null;
}) {
  const t = useTranslations('metrics');
  const layerLabel = useDatasetLayerLabel();
  const [groups, setGroups] = useState<DatasetGroups | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/data/datasets', { cache: 'no-store' });
        if (res.ok) setGroups(await res.json());
      } catch { /* surfaced by the define call */ }
    })();
  }, []);

  // LIVE connected datasets are NOT metric sources (lakehouse-import-exposure.md, v1) —
  // a live-federated external table has no governed gold mart to bind a metric to, so it is
  // excluded from the picker with a plain steer to a synced copy (no dead option).
  const notLive = (tiles: DatasetTile[]) => tiles.filter((d) => d.connected?.mode !== 'live');
  const group = (label: string, tiles: DatasetTile[]) => {
    const usable = notLive(tiles);
    return usable.length ? (
      <optgroup key={label} label={label}>
        {usable.map((d) => (
          <option key={d.id} value={d.id}>{d.name} · {layerLabel(d.tier)}</option>
        ))}
      </optgroup>
    ) : null;
  };

  // Do any live connected datasets exist that we excluded? Show the honest steer.
  const hasHiddenLive = !!groups && [...groups.mine, ...groups.domain, ...groups.marketplace]
    .some((d) => d.connected?.mode === 'live');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 260 }}>
        <option value="">{t('builder.chooseDataset')}</option>
        {groups ? (
          <>
            {group(t('builder.groupMine'), groups.mine)}
            {group(t('builder.groupDomain'), groups.domain)}
            {group(t('builder.groupCompany'), groups.marketplace)}
          </>
        ) : null}
      </select>
      {hasHiddenLive ? (
        <p className="hint" style={{ margin: 0 }}>
          {t.rich('builder.liveHidden', { strong: (c) => <strong>{c}</strong> })}
        </p>
      ) : null}
      {value && selectedDeliverable === false ? (
        <p className="hint" style={{ margin: 0 }}>
          {t.rich('builder.noGold', { strong: (c) => <strong>{c}</strong> })}
        </p>
      ) : null}
    </div>
  );
}

function toPayload(form: Form) {
  const isFormula = form.aggregation === 'formula';
  const payload: Record<string, unknown> = {
    // 'formula' is UI-only — the wire aggregation is 'number' with a formula field.
    name: form.name.trim(),
    aggregation: isFormula ? 'number' : form.aggregation,
    column: isFormula ? '' : form.column.trim(),
    dimensions: form.dimensions,
  };
  if (isFormula) payload.formula = form.formula.trim();
  if (form.filter.on && form.filter.column) {
    payload.filter = { column: form.filter.column, operator: form.filter.operator, value: form.filter.value };
  }
  if (form.windowMode === 'running') payload.runningTotal = true;
  else if (form.windowMode === 'trailing') payload.rollingWindow = { amount: form.windowAmount, unit: form.windowUnit };
  if (form.aggregation === 'number') payload.ratio = { numerator: form.ratio.numerator.trim(), denominator: form.ratio.denominator.trim() };
  if (form.format) payload.format = form.format;
  if (form.description.trim()) payload.description = form.description.trim();
  return payload;
}

/** The definition in PLAIN TERMS for View — "Sum of net_amount · only rows where … · trailing 7 days". */
function describeDefinition(form: Form, t: MetricsT): string {
  const parts: string[] = [];
  if (form.aggregation === 'formula' || form.formula.trim()) parts.push(t('definition.formula', { formula: form.formula.trim() || '…' }));
  else if (form.aggregation === 'number') parts.push(`${form.ratio.numerator || '…'} ÷ ${form.ratio.denominator || '…'}`);
  else if (form.aggregation === 'count') parts.push(t('builder.agg.count.label'));
  else {
    const agg = AGGREGATIONS.find((a) => a.value === form.aggregation);
    parts.push(t('definition.aggOf', { agg: agg ? t(`builder.agg.${agg.key}.label`) : form.aggregation, column: form.column || '…' }));
  }
  if (form.filter.on && form.filter.column) {
    const op = isOperator(form.filter.operator) ? t(`builder.op.${form.filter.operator}`) : form.filter.operator;
    const bare = form.filter.operator === 'set' || form.filter.operator === 'notSet';
    parts.push(bare
      ? t('definition.filter', { column: form.filter.column, op })
      : t('definition.filterValue', { column: form.filter.column, op, value: form.filter.value }));
  }
  if (form.windowMode === 'running') parts.push(t('definition.running'));
  else if (form.windowMode === 'trailing') parts.push(t('definition.trailing', { count: form.windowAmount, unit: form.windowUnit }));
  if (form.format) parts.push(t('definition.shownAs', { format: form.format }));
  return parts.join(' · ');
}

/* ──────────────────────────── main component ───────────────────────────── */

/**
 * The Metrics builder — a plain View/Edit surface (no staged flow). A NEW metric opens in
 * EDIT (source dataset + name + the full refine form + Save). An EXISTING metric opens in
 * VIEW: a read-first walk-through (definition in plain terms · the governed SQL it compiles
 * to · the source dataset + layer · usable dimensions · the live preview · Talk to Metric ·
 * Alerts). Save is the SAME define/validation flow — it lands you in View. Promotion +
 * lifecycle live in the detail HEADER. Reuses existing pieces (ExploreMetric, Alerts,
 * PromoteButton, LifecycleActions) without rewriting them.
 */
export default function MetricBuilder({
  existing,
  initialDatasetId,
  metricKind,
  metrics,
  metricsLoading,
  onBack,
  onChanged,
}: {
  /** Open an existing saved metric (lands at View), or null to create a new one (Edit). */
  existing: MetricSummary | null;
  /** Preselect this dataset when creating a new metric (Data tab → "＋ New metric" deep-link). */
  initialDatasetId?: string;
  /** The path picked in the type chooser for a NEW metric — 'complex' opens the formula
   *  editor first-class; 'simple' opens the aggregation form. Ignored for an existing metric
   *  (its kind is derived from its saved measure). */
  metricKind?: MetricKind;
  metrics: MetricGroups | null;
  metricsLoading: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('metrics');
  const serverMsg = useServerMessage();
  const tc = useTranslations('common');
  const layerLabel = useDatasetLayerLabel();
  const { user } = useUser();
  const toast = useToast();

  /* ── Simple ⇄ Developer view mode ── */
  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(METRIC_MODE_KEY);
    if (saved === 'simple' || saved === 'developer') setViewMode(saved);
  }, []);
  const setModePersisted = (m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(METRIC_MODE_KEY, m);
  };

  /* ── form state ── */
  // An existing metric binds to ITS dataset; a new one seeds from the deep-link
  // (Data tab → "＋ New metric") when present.
  const [datasetId, setDatasetId] = useState(existing ? existing.datasetId : (initialDatasetId ?? ''));
  // A NEW metric seeds its aggregation from the chooser path: 'complex' opens the formula
  // editor (UI aggregation 'formula'), 'simple' opens the aggregation form (default sum).
  // An existing metric hydrates from its saved measure, so this seed is irrelevant there.
  const [form, setForm] = useState<Form>(
    () => (!existing && metricKind === 'complex' ? { ...EMPTY_FORM, aggregation: 'formula' } : EMPTY_FORM),
  );
  const [usedAgent, setUsedAgent] = useState(false);
  const { columns, columnDocs, measures, description, deliverable, tier: datasetTier } = useDataset(datasetId);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  // View ⇄ Edit: a NEW metric opens in Edit; an EXISTING one opens in View.
  const [mode, setMode] = useState<'view' | 'edit'>(existing ? 'view' : 'edit');

  // Hydrate the form from the SAVED measure (formFromMeasure — the tested inverse of the
  // define builder), so View can describe the definition and Edit edits IN PLACE: the
  // hydrated `name` is the frozen measure name, so a re-save lands on the same member.
  useEffect(() => {
    if (!existing) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/metrics/${existing.id}`, { cache: 'no-store' });
        const d = await res.json();
        if (!live || !res.ok) return;
        const f: MetricForm = formFromMeasure(d.metric.measure);
        setForm({
          name: f.name,
          description: f.description ?? '',
          // A composite metric re-opens as the 'formula' option (wire type is 'number').
          aggregation: f.formula ? 'formula' : f.aggregation,
          column: f.column,
          dimensions: f.dimensions,
          filter: f.filter
            ? { on: true, column: f.filter.column, operator: f.filter.operator, value: f.filter.value }
            : EMPTY_FORM.filter,
          windowMode: f.runningTotal ? 'running' : f.rollingWindow ? 'trailing' : 'none',
          windowAmount: f.rollingWindow?.amount ?? EMPTY_FORM.windowAmount,
          windowUnit: f.rollingWindow?.unit ?? EMPTY_FORM.windowUnit,
          ratio: f.ratio ?? EMPTY_FORM.ratio,
          formula: f.formula ?? '',
          format: f.format ?? '',
          timeDimension: '',
          granularity: 'month',
        });
      } catch { /* form stays empty — Edit still works from scratch */ }
    })();
    return () => { live = false; };
  }, [existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isRatio = form.aggregation === 'number';
  const isFormula = form.aggregation === 'formula';
  const needsColumn = !isRatio && !isFormula && form.aggregation !== 'count';
  // The chips a formula can reference — BASIC sibling metrics only (never another formula/ratio).
  const basicMeasures = useMemo(() => measures.filter((m) => m.type !== 'number'), [measures]);

  // Live formula validation (P1-5) — the Power BI formula-bar feel. Compiles as you type and
  // checks the refs against basicMeasures; PREVIEW feedback only (server stays authoritative).
  // Empty formula = no message. `{ error }` shows the FormulaError inline; `{ refs }` shows the
  // resolved [ref] ✓ ok-chips. This never blocks Save — canSubmit only checks non-emptiness.
  const formulaCheck = useMemo((): { error?: string; refs?: string[] } => {
    if (!isFormula) return {};
    const src = form.formula.trim();
    if (!src) return {};
    try {
      const { refs } = compileFormula(src);
      assertFormulaRefs(refs, basicMeasures);
      return { refs };
    } catch (e) {
      return { error: e instanceof FormulaError ? t(`formula.errors.${e.key}`, e.args) : (e as Error).message };
    }
  }, [isFormula, form.formula, basicMeasures, t]);

  const sliceMembers = useMemo(() => {
    const pk = columns.find((c) => /(^|_)id$/.test(c.toLowerCase())) ?? columns[0];
    return columns.filter((c) => c !== pk);
  }, [columns]);

  const timeColumns = useMemo(
    () => columns.filter((c) => /(_at|_date|_ts|_time|date|timestamp)$/i.test(c) || c.toLowerCase() === 'date'),
    [columns],
  );

  const toggleDimension = (col: string) =>
    setForm((f) => ({
      ...f,
      dimensions: f.dimensions.includes(col)
        ? f.dimensions.filter((d) => d !== col)
        : [...f.dimensions, col],
    }));

  /* ── preview state ── */
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  /* ── save state ── */
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [result, setResult] = useState<DefineResult | null>(null);

  // canSubmit drives the "valid measure" gate for Preview + Publish.
  const canSubmit =
    !busy && datasetId !== '' && form.name.trim() !== '' &&
    (form.aggregation === 'count'
      ? true
      : isFormula
        ? form.formula.trim() !== ''
        : isRatio
          ? form.ratio.numerator.trim() !== '' && form.ratio.denominator.trim() !== ''
          : form.column.trim() !== '');

  // The "saved" metric — either the pre-existing one or the one we just saved.
  const saved: MetricSummary | null = useMemo(() => {
    if (existing) return existing;
    if (result) {
      // Build a minimal MetricSummary from the define result so Monitor can open.
      // id MUST be "${datasetId}.${measureName}" — the same format getMetric() and
      // summariesFor() use — so the explore/govern routes can split it correctly.
      return {
        id: `${datasetId}.${result.measure.name}`,
        name: form.name.trim(),
        datasetId,
        datasetName: '',
        member: result.member,
        tier: 'personal',
        owner: user?.id ?? '',
        type: result.measure.type ?? form.aggregation,
        folder: '/',
      } satisfies MetricSummary;
    }
    return null;
  }, [existing, result, form.name, datasetId, user?.id]);

  /* ── preview ── */
  const runPreview = useCallback(async () => {
    if (!canSubmit) { setPreviewErr(t('builder.completeFirst')); setPreview(null); return; }
    setPreviewErr(''); setPreviewBusy(true);
    try {
      const res = await fetch('/api/metrics/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          datasetId,
          form: toPayload(form),
          dimensions: form.dimensions,
          timeDimension: form.timeDimension || undefined,
          granularity: form.timeDimension ? form.granularity : undefined,
          limit: 50,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setPreviewErr(serverMsg(data, t('builder.previewFailed'))); setPreview(null); return; }
      const p: PreviewResult = { member: data.member, rows: data.rows ?? [], mode: data.mode, pending: data.pending, warning: data.warning, sql: data.sql };
      setPreview(p);
    } catch (e) { setPreviewErr((e as Error).message); setPreview(null); } finally { setPreviewBusy(false); }
  }, [canSubmit, datasetId, form, t]);

  // Auto-poll while pending — up to 6 times (30 s total, 5 s interval). Only once the
  // metric is SAVED: post-save pending is sidecar sync lag and resolves by waiting;
  // pre-save pending (a rolling-window draft) can't resolve until Publish, so polling
  // would just spin.
  useEffect(() => {
    if (!preview?.pending || !saved) return;
    let tries = 0;
    const MAX = 6;
    const id = setInterval(async () => {
      tries++;
      await runPreview();
      if (tries >= MAX) clearInterval(id);
    }, 5000);
    return () => clearInterval(id);
  }, [preview?.pending, saved, runPreview]);

  // View resolves the metric's number + governed SQL automatically (once the form is
  // hydrated enough to be valid) — "how it is calculated" needs no button press.
  useEffect(() => {
    if (mode === 'view' && saved && canSubmit && !preview && !previewBusy) void runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, saved, canSubmit]);

  /* ── save ── */
  const submit = useCallback(async () => {
    setSaveErr(''); setBusy(true); setResult(null);
    const payload = toPayload(form);
    try {
      const res = await fetch('/api/metrics/define', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetId, form: payload, agent: usedAgent ? payload : undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = serverMsg(data, t('builder.defineFailed'));
        setSaveErr(msg); toast.error(msg); return;
      }
      setResult(data);
      toast.success(t('builder.toastSaved', { name: form.name || t('builder.metricFallback') }));
      setMode('view'); // saving lands you in View — the read-first home of a saved metric
      setPreview(null); // the saved definition may differ — View re-resolves it
      onChanged();
    } catch (e) { const msg = (e as Error).message; setSaveErr(msg); toast.error(msg); } finally { setBusy(false); }
  }, [datasetId, form, usedAgent, onChanged, toast, t]);

  /* ── governance ── */
  const canManage = !!user && !!saved && canManageArtifact(user, { owner: saved.owner, domain: saved.domain ?? '' });
  const canApprove = !!user && roleAtLeast(user.role, 'builder');
  const onLifecycle = () => { onChanged(); onBack(); };

  // Inline rename of the DISPLAY name (edit-gated). The metric's physical member
  // (`saved.member`) is FROZEN — the store writes a `label` and never moves the Cube
  // member — so renaming is safe. Mirrors the Data tab's labelled "✎ Rename" affordance.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameErr, setRenameErr] = useState('');
  const renameMetric = async () => {
    if (!saved) return;
    const name = nameDraft.trim();
    setRenameErr('');
    if (!name) { setRenaming(false); return; }
    const res = await fetch(`/api/metrics/${saved.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRenameErr(serverMsg(d, t('builder.renameFailed'))); return; }
    setRenaming(false);
    onChanged();
  };

  /* ── render ── */
  return (
    <ConfirmProvider>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>{t('chooser.back')}</button>
        <BuilderModeToggle
          mode={viewMode}
          onChange={setModePersisted}
          developerHint={t('builder.developerHint')}
        />
      </div>

      {saved ? (
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          {renaming ? (
            <span className="rename-inline">
              <input
                className="rename-input"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void renameMetric(); if (e.key === 'Escape') setRenaming(false); }}
                onBlur={() => void renameMetric()}
                aria-label={t('builder.nameAria')}
              />
              <button className="btn primary sm" onClick={() => void renameMetric()}>{t('builder.save')}</button>
              <button className="btn ghost sm" onClick={() => setRenaming(false)}>{tc('actions.cancel')}</button>
            </span>
          ) : (
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              {saved.name}
              {/* Rename must be DISCOVERABLE — a labelled button (mirrors the Data tab). The
                  physical member stays frozen; only the display label changes. */}
              {canManage ? (
                <button
                  className="btn ghost sm"
                  style={{ flex: 'none' }}
                  onClick={() => { setNameDraft(saved.name); setRenameErr(''); setRenaming(true); }}
                  title={t('builder.renameTitle')}
                  aria-label={t('builder.renameAria')}
                >{t('builder.rename')}</button>
              ) : null}
            </h2>
          )}
          <span className={`badge ${TIER_BADGE[saved.tier]}`}><TierWord tier={saved.tier} /></span>
          {(saved.tier === 'domain' || saved.tier === 'marketplace') ? <DomainTag domain={saved.domain} /> : null}
          <span className="muted mono" style={{ fontSize: 12 }}>{saved.member}</span>
          {' '}· <GitHeadBadge kind="metric" id={saved.id} />
          {renameErr ? <span className="error-inline" style={{ fontSize: 12 }}>{renameErr}</span> : null}
          {/* Header actions: View⇄Edit toggle · Promote (left of Archive, per the OS-wide
              pattern) · lifecycle (Archive/Restore/Delete). Governance unchanged (canManage). */}
          {canManage ? (
            <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {mode === 'view' ? (
                <button className="btn ghost sm" onClick={() => setMode('edit')} title={t('builder.editTitle')}>{t('builder.edit')}</button>
              ) : (
                <button className="btn ghost sm" onClick={() => setMode('view')} title={t('builder.viewTitle')}>{t('builder.view')}</button>
              )}
              <PromoteButton
                id={saved.id}
                kind="metric"
                tier={ladderTier(saved.tier)}
                promoteUrl={`/api/metrics/${saved.id}/promote`}
                canApprove={canApprove}
                onDone={onChanged}
              />
              {/* A metric's tier is DERIVED from its dataset, so revoking moves the
                  dataset AND every metric on it — the confirm copy says so honestly. */}
              <DemoteButton
                kind="metric"
                tier={saved.tier === 'marketplace' ? 'Marketplace' : saved.tier === 'domain' ? 'Shared' : 'Personal'}
                // Demoting a metric lowers its underlying DATASET, so the warn reflects the
                // dataset's blast radius (its dashboards/apps/agents), not just this metric.
                artifactId={saved.datasetId}
                demoteUrl={`/api/metrics/${saved.id}/demote`}
                onDone={onChanged}
                body={saved.tier === 'marketplace'
                  ? t('builder.demoteFromCompany')
                  : t('builder.demoteFromDomain')}
              />
              <LifecycleActions
                id={saved.id}
                name={saved.name}
                kind="metric"
                visibility={lcVis(saved.tier)}
                archived={!!saved.archived}
                api={`/api/metrics/${saved.id}`}
                onChanged={onLifecycle}
                compact
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {viewMode === 'developer' ? (
        <MetricDeveloperView result={result} form={form} datasetId={datasetId} />
      ) : mode === 'edit' ? (
        /* ── Edit — Define + Refine combined: source → name → AI-fillable form → Save ── */
        <div>
          {/* An EXISTING metric is bound to its dataset and its frozen member — the
              dataset can't move and the display name renames in the header — so the
              source + name panels only show when creating a NEW metric. */}
          {!saved ? (
            <>
            <div className="guided-panel" style={{ marginTop: 4 }}>
              <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <span className="comp-label" style={{ margin: 0, marginTop: 6 }}>{t('builder.sourceDataset')}</span>
                <DatasetPicker
                  value={datasetId}
                  onChange={setDatasetId}
                  selectedDeliverable={datasetId ? deliverable : null}
                />
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                {t('builder.sourceHint')}
              </p>
            </div>

            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>{t('builder.name')}</span>
              <input
                placeholder={t('builder.namePlaceholder')}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                style={{ marginTop: 8, maxWidth: 320 }}
              />

              {/* A plain-language note captured up front, so the metric arrives with its
                  meaning already written. Optional; shown on the tile and in the Definition
                  panel. Suggest with AI proposes a draft here too. */}
              <span className="comp-label" style={{ margin: 0, marginTop: 14 }}>{t('builder.meaning')}</span>
              <textarea
                placeholder={t('builder.meaningPlaceholder')}
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
                rows={2}
                aria-label={t('builder.descriptionAria')}
                style={{ marginTop: 8, width: '100%', resize: 'vertical' }}
              />
              <p className="hint" style={{ marginTop: 6 }}>{t('builder.optional')}</p>
            </div>
            </>
          ) : null}

            {/* AI, in the flow: ONE big action — reads the dataset's columns and FILLS
                the form below from the metric name; you review, adjust and continue.
                Hidden for a COMPLEX metric — it fills the aggregation form, not a formula,
                which you author from the metric chips below. */}
            {isFormula ? null : (
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
              <MetricStageAssistant
                compact
                stage="define"
                label={t('builder.aiLabel')}
                cta={t('builder.aiCta')}
                disabled={!datasetId || columns.length === 0 || !(saved?.name ?? form.name).trim()}
                payload={() => ({
                  // The metric NAME is the goal — one field, no separate goal box. An
                  // existing metric's goal is its DISPLAY name (the form holds the frozen member name).
                  goal: (saved?.name ?? form.name).trim() || 'define a useful metric on this dataset',
                  columns,
                  // Ground the proposal in the documented schema — column docs,
                  // the dataset description and the measures already defined.
                  columnDocs: columnDocs.filter((c) => c.description),
                  datasetDescription: description,
                  measures,
                })}
                onForm={(f) => {
                  // NEVER overwrite an existing metric's frozen name — a changed name
                  // would slug to a NEW member on save instead of editing in place.
                  if (f.name && !saved) set({ name: f.name });
                  if (f.aggregation && AGGREGATIONS.some((a) => a.value === f.aggregation)) set({ aggregation: f.aggregation });
                  if (f.column && columns.includes(f.column)) set({ column: f.column });
                  if (Array.isArray(f.dimensions)) set({ dimensions: f.dimensions.filter((d) => columns.includes(d)) });
                  // A proposed plain-language description fills the note — the user reviews
                  // and edits it before saving (nil-safe: absent leaves the field untouched).
                  if (typeof f.description === 'string' && f.description.trim()) set({ description: f.description.trim() });
                  setUsedAgent(true);
                }}
              />
            </div>
            )}

            {/* What to measure — a SIMPLE metric picks an aggregation + column; a COMPLEX
                metric (isFormula) leads with the formula editor instead (the aggregation
                dropdown is hidden — the type chooser already made that decision). */}
            <div className="guided-panel" style={{ marginTop: 4 }}>
              <span className="comp-label" style={{ margin: 0 }}>{isFormula ? t('builder.formula') : t('builder.whatToMeasure')}</span>
              {!isFormula ? (
              <>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <select value={form.aggregation} onChange={(e) => set({ aggregation: e.target.value })} style={{ minWidth: 220 }}>
                  {AGGREGATIONS.map((a) => <option key={a.value} value={a.value}>{t(`builder.agg.${a.key}.label`)}</option>)}
                </select>
                {needsColumn ? (
                  <select
                    value={columns.includes(form.column) ? form.column : ''}
                    onChange={(e) => set({ column: e.target.value })}
                    disabled={!datasetId || columns.length === 0}
                    style={{ minWidth: 200 }}
                  >
                    <option value="">{columns.length === 0 ? t('builder.noColumns') : t('builder.ofColumn')}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : null}
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                {(() => { const a = AGGREGATIONS.find((x) => x.value === form.aggregation); return a ? t(`builder.agg.${a.key}.hint`) : null; })()}
              </p>

              {/* Narrowest-dataset guidance: if the column you need isn't on THIS dataset,
                  the honest fix is a curated (joined) dataset in Data — never an invented
                  join here. Shown when an aggregation needs a column the dataset lacks. */}
              {needsColumn && datasetId && columns.length === 0 ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  {t.rich('builder.noDocumentedColumns', { strong: (c) => <strong>{c}</strong> })}
                </p>
              ) : null}
              </>
              ) : null}

              {isRatio ? (
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  <span className="hint" style={{ margin: 0 }}>{t('builder.divide')}</span>
                  <select value={form.ratio.numerator} onChange={(e) => set({ ratio: { ...form.ratio, numerator: e.target.value } })} disabled={measures.length === 0} style={{ minWidth: 160 }}>
                    <option value="">{t('builder.numerator')}</option>
                    {measures.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                  <span className="hint" style={{ margin: 0 }}>{t('builder.divideBy')}</span>
                  <select value={form.ratio.denominator} onChange={(e) => set({ ratio: { ...form.ratio, denominator: e.target.value } })} disabled={measures.length === 0} style={{ minWidth: 160 }}>
                    <option value="">{t('builder.denominator')}</option>
                    {measures.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                  {measures.length === 0 ? <span className="hint" style={{ margin: 0 }}>{t('builder.defineBaseFirst')}</span> : null}
                </div>
              ) : null}

              {isFormula ? (
                !datasetId ? (
                  <p className="hint" style={{ marginTop: 10 }}>{t('builder.chooseDatasetFirst')}</p>
                ) : basicMeasures.length === 0 ? (
                  /* Honest empty state — a formula has nothing to reference until this
                     dataset has at least one basic metric. Don't offer a dead editor. */
                  <p className="hint" style={{ marginTop: 10 }}>
                    {t.rich('builder.noBasicMetrics', { strong: (c) => <strong>{c}</strong> })}
                  </p>
                ) : (
                <div style={{ marginTop: 10 }}>
                  {/* The dataset's EXISTING basic metrics — click a chip to insert [name];
                      free typing works too. */}
                  <span className="hint" style={{ display: 'block' }}>
                    {t.rich('builder.formulaHint', { code: (c) => <code>{c}</code> })}
                  </span>
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {basicMeasures.map((m) => (
                      <button
                        key={m.name}
                        type="button"
                        className="chip"
                        style={{ cursor: 'pointer' }}
                        onClick={() => set({ formula: `${form.formula}${form.formula && !form.formula.endsWith(' ') ? ' ' : ''}[${m.name}]` })}
                        title={t('builder.insertRef', { name: m.name, type: m.type })}
                      >
                        [{m.name}] <span className="mono" style={{ opacity: 0.7 }}>{m.type}</span>
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="mono"
                    rows={2}
                    // i18n-ignore — formula syntax over metric machine names (code), not prose
                    placeholder="([revenue] - [cost]) / [orders]"
                    value={form.formula}
                    onChange={(e) => set({ formula: e.target.value })}
                    style={{ width: '100%', resize: 'vertical', marginTop: 8 }}
                    aria-label={t('builder.formulaAria')}
                  />
                  {/* Live validation — inline error as you type, or the resolved refs as
                      ok-chips when valid. Preview only; the server stays authoritative. */}
                  {formulaCheck.error ? (
                    <span className="error-inline" role="alert" style={{ display: 'block', marginTop: 6 }}>{formulaCheck.error}</span>
                  ) : formulaCheck.refs?.length ? (
                    <div className="chip-row" style={{ marginTop: 6 }}>
                      {formulaCheck.refs.map((r) => (
                        <span key={r} className="chip ok" title={t('builder.refResolves', { ref: r })}>[{r}] ✓</span>
                      ))}
                    </div>
                  ) : null}
                </div>
                )
              ) : null}
            </div>

            {/* Filter — not applicable to a composite formula (its parts carry their own
                filters); hidden rather than silently dropped on save. */}
            {isFormula ? null : (
            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>{t('builder.filter')}</span>
              <div style={{ marginTop: 10 }}>
                <label className="chk" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.filter.on} onChange={(e) => set({ filter: { ...form.filter, on: e.target.checked } })} />
                  {t('builder.filterOn')}
                </label>
                {form.filter.on ? (
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <select value={form.filter.column} onChange={(e) => set({ filter: { ...form.filter, column: e.target.value } })} disabled={columns.length === 0} style={{ minWidth: 160 }}>
                      <option value="">{t('builder.column')}</option>
                      {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select value={form.filter.operator} onChange={(e) => set({ filter: { ...form.filter, operator: e.target.value } })}>
                      {OPERATORS.map((o) => <option key={o} value={o}>{t(`builder.op.${o}`)}</option>)}
                    </select>
                    {form.filter.operator !== 'set' && form.filter.operator !== 'notSet' ? (
                      <input placeholder={t('builder.value')} value={form.filter.value} onChange={(e) => set({ filter: { ...form.filter, value: e.target.value } })} style={{ maxWidth: 160 }} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            )}

            {/* Time window — likewise not carried by a formula; hidden, not dropped. */}
            {isFormula ? null : (
            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>{t('builder.timeWindow')}</span>
              <div className="seg" style={{ marginTop: 8 }}>
                <button className={form.windowMode === 'none' ? 'on' : ''} onClick={() => set({ windowMode: 'none' })}>{t('builder.windowNone')}</button>
                <button className={form.windowMode === 'running' ? 'on' : ''} onClick={() => set({ windowMode: 'running' })}>{t('builder.windowRunning')}</button>
                <button className={form.windowMode === 'trailing' ? 'on' : ''} onClick={() => set({ windowMode: 'trailing' })}>{t('builder.windowTrailing')}</button>
              </div>
              {form.windowMode === 'trailing' ? (
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <span className="hint" style={{ margin: 0 }}>{t('builder.last')}</span>
                  <input type="number" min={1} value={form.windowAmount} onChange={(e) => set({ windowAmount: Math.max(1, Number(e.target.value) || 1) })} style={{ maxWidth: 80 }} />
                  <select value={form.windowUnit} onChange={(e) => set({ windowUnit: e.target.value as Form['windowUnit'] })}>
                    {WINDOW_UNITS.map((u) => <option key={u} value={u}>{t(`builder.unitPlural.${u}`)}</option>)}
                  </select>
                </div>
              ) : form.windowMode === 'running' ? (
                <p className="hint" style={{ marginTop: 6 }}>{t('builder.cumulative')}</p>
              ) : null}
            </div>
            )}

            {/* Format + slice */}
            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>{t('builder.formatDimensions')}</span>
              <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 10 }}>
                <span className="hint" style={{ margin: 0 }}>{t('builder.displayAs')}</span>
                <select value={form.format} onChange={(e) => set({ format: e.target.value })}>
                  {FORMATS.map((f) => <option key={f.value} value={f.value}>{t(`builder.format.${f.key}`)}</option>)}
                </select>
              </div>
              {sliceMembers.length > 0 ? (
                <>
                  <span className="hint" style={{ marginTop: 12, display: 'block' }}>{t('builder.sliceBy')}</span>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    {sliceMembers.filter((c) => c !== form.column).map((c) => (
                      <button key={c} type="button" className={`switch${form.dimensions.includes(c) ? ' on' : ''}`} onClick={() => toggleDimension(c)}>
                        <span className="switch-track"><span className="switch-thumb" /></span>
                        <span className="switch-text">{c}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {timeColumns.length > 0 ? (
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                  <span className="hint" style={{ margin: 0 }}>{t('builder.overTime')}</span>
                  <select value={form.timeDimension} onChange={(e) => set({ timeDimension: e.target.value })} style={{ minWidth: 160 }}>
                    <option value="">{t('builder.notByTime')}</option>
                    {timeColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {form.timeDimension ? (
                    <select value={form.granularity} onChange={(e) => set({ granularity: e.target.value as Form['granularity'] })}>
                      {GRAINS.map((g) => <option key={g} value={g}>{t('builder.byGrain', { grain: g })}</option>)}
                    </select>
                  ) : null}
                </div>
              ) : null}
            </div>

          {/* Save — the SAME define/validation flow; success lands you in View. While the
              save runs, the OS-wide BusyProgress names what the server is doing (persist →
              convergence proof → live build + verify) instead of a silently disabled button. */}
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={submit} disabled={!canSubmit || busy}>
                {busy ? <span className="spin" /> : saved ? t('builder.saveChanges') : t('builder.saveMetric')}
              </button>
              <span className="hint" style={{ margin: 0 }}>
                {saved ? t('builder.updatesInPlace') : t('builder.servesSoon')}
              </span>
            </div>
            {busy ? (
              <BusyProgress
                label={saved ? t('builder.savingChanges') : t('builder.savingMetric')}
                detail={t('builder.savingDetail')}
                typicalSeconds={30}
              />
            ) : null}
            {saveErr ? <div className="error" style={{ marginTop: 10 }}>{saveErr}</div> : null}
          </div>
        </div>

      ) : saved ? (
        /* ── View — read-first: definition · governed SQL · data underneath · usable
              dimensions · live preview · Alerts ── */
        <div>
          {/* Definition in plain terms + the data underneath */}
          <div className="guided-panel" style={{ marginTop: 28 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('view.definition')}</span>
            {/* The author's plain-language meaning leads when present; the technical
                one-liner (aggregation · filter · window) then supports it underneath. */}
            {form.description.trim() ? (
              <p className="lead" style={{ marginTop: 8, marginBottom: 0 }}>{form.description.trim()}</p>
            ) : null}
            <p className={form.description.trim() ? 'hint' : 'lead'} style={{ marginTop: form.description.trim() ? 10 : 8, marginBottom: 0 }}>{describeDefinition(form, t)}</p>
            <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
              {t.rich(datasetTier ? 'view.onDatasetLayer' : 'view.onDataset', {
                dataset: saved.datasetName || saved.datasetId,
                layer: datasetTier ? layerLabel(datasetTier) : '',
                member: saved.member,
                strong: (c) => <strong>{c}</strong>,
                code: (c) => <code>{c}</code>,
              })}
            </p>
            {sliceMembers.length > 0 ? (
              <>
                <span className="hint" style={{ marginTop: 12, display: 'block' }}>{t('view.dimensions')}</span>
                <div className="chip-row" style={{ marginTop: 6 }}>
                  {sliceMembers.map((c) => <span key={c} className="chip">{c}</span>)}
                </div>
              </>
            ) : null}
          </div>

          {/* How it is calculated — the governed Trino SQL the number comes from */}
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('view.howCalculated')}</span>
            {preview?.sql ? (
              <pre className="codeblock" style={{ marginTop: 10 }}>{preview.sql}</pre>
            ) : preview?.pending ? (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                {t('view.syncing')}
              </p>
            ) : (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                {previewBusy ? t('view.resolvingSql') : previewErr || t('view.sqlLater')}
              </p>
            )}
          </div>

          {/* Live preview — the number itself, explorable (slice, trend) */}
          <div style={{ marginTop: 14 }}>
            <ExploreMetric metric={saved} />
          </div>

          {/* On dashboards — where this metric APPEARS (the Power BI pin-visual loop):
              every visible dashboard bound to this metric's view, plus the one-click
              "Add to a dashboard" that opens the builder with this metric pre-selected. */}
          <OnDashboards metric={saved} />

          {/* Alerts */}
          <div className="section-title" style={{ marginTop: 28 }}>{t('alerts.title')}</div>
          <Alerts metrics={metrics} loading={metricsLoading} presetMember={saved.member} />

          {/* Connect Power BI is REMOVED from View for now — the connection is unverified;
              restore <ConnectPowerBI domain={saved.domain} /> once it is proven working. */}
          {/* night-2 stream T: the tool-native artefacts of this KPI. */}
          <TechnicalDetailsOnly><UnderTheHood kind="metric" id={saved.id} /></TechnicalDetailsOnly>
          <CloneRepository domain={saved.domain} />
        </div>
      ) : (
        <div className="chat-empty">{t('view.nothingYet')}</div>
      )}
    </ConfirmProvider>
  );
}

/* ─────────────────────────── On dashboards ─────────────────────────── */

/** The dashboards list shape this section needs (kept local — no cross-tab import). */
type DashListItem = { id: string; name: string; view: string; charts: number };
type DashList = { mine: DashListItem[]; domain: DashListItem[]; marketplace: DashListItem[] };

/**
 * Where this metric APPEARS — every dashboard the viewer can see that binds this
 * metric's view (RLS-scoped by the /api/dashboards route), each a click away — plus
 * "＋ Add to a dashboard", which opens the Dashboards builder with this metric
 * pre-selected in a fresh panel. Closes the metric ⇄ dashboard loop both ways.
 */
function OnDashboards({ metric }: { metric: MetricSummary }) {
  const t = useTranslations('metrics');
  const [dashboards, setDashboards] = useState<DashListItem[] | null>(null);
  const view = metric.member.split('.')[0];
  useEffect(() => {
    let alive = true;
    fetch('/api/dashboards', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((g: DashList | null) => {
        if (!alive) return;
        const all = g ? [...g.mine, ...g.domain, ...g.marketplace] : [];
        setDashboards(all.filter((d) => d.view === view));
      })
      .catch(() => { if (alive) setDashboards([]); });
    return () => { alive = false; };
  }, [view]);

  const addHref = `/dashboards?new=1&dataset=${encodeURIComponent(metric.datasetId)}&metric=${encodeURIComponent(metric.member)}`;

  return (
    <div className="guided-panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <span className="comp-label" style={{ margin: 0 }}>{t('dashboards.title')}</span>
        <Link className="btn ghost sm" href={addHref} title={t('dashboards.addTitle')}>
          {t('dashboards.add')}
        </Link>
      </div>
      {dashboards === null ? (
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{t('dashboards.loading')}</p>
      ) : dashboards.length === 0 ? (
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          {t('dashboards.none')}
        </p>
      ) : (
        <div className="chip-row" style={{ marginTop: 8 }}>
          {dashboards.map((d) => (
            <Link
              key={d.id}
              className="chip"
              href={`/dashboards?focus=${encodeURIComponent(d.id)}`}
              title={t('dashboards.open', { name: d.name })}
              style={{ cursor: 'pointer' }}
            >
              {d.name} <span className="mono" style={{ opacity: 0.7 }}>{t('dashboards.panels', { count: d.charts })}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Developer surface ─────────────────────────── */

/**
 * The Metrics Developer view — shows the real Cube measure YAML that the OS generates
 * for this metric. If a metric has been saved (`result.cube` from the define API), the
 * YAML is surfaced read-only; if not yet saved, the form payload is shown as JSON so
 * the developer can see what will be submitted. Nothing is fabricated — both surfaces
 * come from real data the builder already holds.
 */
function MetricDeveloperView({
  result,
  form,
  datasetId,
}: {
  result: DefineResult | null;
  form: Form;
  datasetId: string;
}) {
  const t = useTranslations('metrics');
  if (result?.definitionYaml) {
    return (
      <div className="grant-block" style={{ marginTop: 4 }}>
        <div className="comp-label">{t('developer.yamlTitle')}</div>
        <p className="hint" style={{ marginTop: 4 }}>{t('developer.yamlHint')}</p>
        <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {result.definitionYaml}
        </pre>
        {result.member ? (
          <p className="hint" style={{ marginTop: 8 }}>
            {t.rich('developer.canonicalMember', { member: result.member, code: (c) => <code>{c}</code> })}
            {result.build?.mode ? <> · {t('developer.mode')} <span className={`badge ${result.build.mode === 'live' ? 'ok' : 'muted'}`}>{result.build.mode}</span></> : null}
          </p>
        ) : null}
      </div>
    );
  }

  // No saved result yet — show the current form payload so the developer can see
  // what will be submitted when they reach the Publish stage.
  const preview = datasetId
    ? { datasetId, ...toPayload(form) }
    : null;

  return (
    <div className="grant-block" style={{ marginTop: 4 }}>
      <div className="comp-label">{t('developer.payloadTitle')}</div>
      <p className="hint" style={{ marginTop: 4 }}>{t('developer.payloadHint')}</p>
      {preview ? (
        <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {JSON.stringify(preview, null, 2)}
        </pre>
      ) : (
        <p className="hint" style={{ marginTop: 8 }}>
          {t('developer.payloadEmpty')}
        </p>
      )}
    </div>
  );
}
