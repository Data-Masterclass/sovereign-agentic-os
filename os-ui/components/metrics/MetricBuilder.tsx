/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import DemoteButton from '@/components/lifecycle/DemoteButton';
import type { Visibility } from '@/lib/core/lifecycle';
import { visibilityForTier } from '@/lib/core/artifact-model';
import DomainTag from '@/components/DomainTag';
import { useToast } from '@/components/core/Toast';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import type { ViewMode } from '@/lib/core/view-mode';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';
import BusyProgress from '@/components/core/BusyProgress';
import MetricStageAssistant from './MetricStageAssistant';
import ExploreMetric from './ExploreMetric';
import Alerts from './Alerts';
import { formFromMeasure, type MetricForm } from '@/lib/metrics/model';
import { compileFormula, assertFormulaRefs, FormulaError } from '@/lib/metrics/formula';
import type { MetricKind } from './MetricTypeChooser';
import {
  type DatasetGroups,
  type DatasetTile,
  type DefineResult,
  type MetricGroups,
  type MetricSummary,
  TIER_BADGE,
  TIER_WORD,
  datasetLayerLabel,
} from './shared';

const METRIC_MODE_KEY = 'metrics.viewMode';

/* ─────────────────────────────── constants ─────────────────────────────── */

// The SIMPLE-path aggregations. The composite 'formula' path is NO LONGER an entry here —
// the type chooser (Simple vs Complex) owns that decision, so nobody has to hunt a buried
// dropdown item to reach a composite metric.
const AGGREGATIONS: { value: string; label: string; hint: string }[] = [
  { value: 'count', label: 'Count of rows', hint: 'how many records' },
  { value: 'sum', label: 'Sum', hint: 'total of a numeric column' },
  { value: 'avg', label: 'Average', hint: 'mean of a numeric column' },
  { value: 'count_distinct', label: 'Count of unique values', hint: 'distinct values in a column' },
  { value: 'count_distinct_approx', label: 'Count of unique (fast, approximate)', hint: 'HyperLogLog — huge datasets' },
  { value: 'min', label: 'Minimum', hint: 'smallest value' },
  { value: 'max', label: 'Maximum', hint: 'largest value' },
  { value: 'number', label: 'Ratio (a ÷ b)', hint: 'divide one measure by another' },
];

const OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'set', label: 'is set' },
  { value: 'notSet', label: 'is empty' },
] as const;

const WINDOW_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const FORMATS = [
  { value: '', label: 'Plain number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'number', label: 'Formatted number' },
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
          // governed tier — metricCubeReady — but that's the dashboards path, not serving.)
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
          <option key={d.id} value={d.id}>{d.name} · {datasetLayerLabel(d.tier)}</option>
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
        <option value="">choose a dataset…</option>
        {groups ? (
          <>
            {group('My', groups.mine)}
            {group('Domain', groups.domain)}
            {group('Company', groups.marketplace)}
          </>
        ) : null}
      </select>
      {hasHiddenLive ? (
        <p className="hint" style={{ margin: 0 }}>
          Live connected datasets aren&apos;t shown — <strong>define metrics on a synced copy</strong>.
        </p>
      ) : null}
      {value && selectedDeliverable === false ? (
        <p className="hint" style={{ margin: 0 }}>
          No <strong>Gold</strong> built yet — build Gold in <strong>Data</strong> first, or the metric can&apos;t serve.
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
function describeDefinition(form: Form): string {
  const parts: string[] = [];
  if (form.aggregation === 'formula' || form.formula.trim()) parts.push(`Formula: ${form.formula.trim() || '…'}`);
  else if (form.aggregation === 'number') parts.push(`${form.ratio.numerator || '…'} ÷ ${form.ratio.denominator || '…'}`);
  else if (form.aggregation === 'count') parts.push('Count of rows');
  else parts.push(`${AGGREGATIONS.find((a) => a.value === form.aggregation)?.label ?? form.aggregation} of ${form.column || '…'}`);
  if (form.filter.on && form.filter.column) {
    const op = OPERATORS.find((o) => o.value === form.filter.operator)?.label ?? form.filter.operator;
    const bare = form.filter.operator === 'set' || form.filter.operator === 'notSet';
    parts.push(`only rows where ${form.filter.column} ${op}${bare ? '' : ` ${form.filter.value}`}`);
  }
  if (form.windowMode === 'running') parts.push('running total');
  else if (form.windowMode === 'trailing') parts.push(`trailing ${form.windowAmount} ${form.windowUnit}${form.windowAmount === 1 ? '' : 's'}`);
  if (form.format) parts.push(`shown as ${(FORMATS.find((f) => f.value === form.format)?.label ?? form.format).toLowerCase()}`);
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
 * TalkTo, PromoteButton, LifecycleActions) without rewriting them.
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
      return { error: e instanceof FormulaError ? e.message : (e as Error).message };
    }
  }, [isFormula, form.formula, basicMeasures]);

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
    if (!canSubmit) { setPreviewErr('Complete Define and Refine first.'); setPreview(null); return; }
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
      if (!res.ok) { setPreviewErr(data.error ?? 'Preview failed'); setPreview(null); return; }
      const p: PreviewResult = { member: data.member, rows: data.rows ?? [], mode: data.mode, pending: data.pending, warning: data.warning, sql: data.sql };
      setPreview(p);
    } catch (e) { setPreviewErr((e as Error).message); setPreview(null); } finally { setPreviewBusy(false); }
  }, [canSubmit, datasetId, form]);

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
        const msg = data.error ?? 'Could not define the metric';
        setSaveErr(msg); toast.error(msg); return;
      }
      setResult(data);
      toast.success(`Metric "${form.name || 'metric'}" saved`);
      setMode('view'); // saving lands you in View — the read-first home of a saved metric
      setPreview(null); // the saved definition may differ — View re-resolves it
      onChanged();
    } catch (e) { const msg = (e as Error).message; setSaveErr(msg); toast.error(msg); } finally { setBusy(false); }
  }, [datasetId, form, usedAgent, onChanged, toast]);

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
    if (!res.ok) { setRenameErr(d.error ?? 'Rename failed'); return; }
    setRenaming(false);
    onChanged();
  };

  /* ── render ── */
  return (
    <ConfirmProvider>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>← All metrics</button>
        <BuilderModeToggle
          mode={viewMode}
          onChange={setModePersisted}
          developerHint="The raw Cube measure YAML this metric generates"
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
                aria-label="Metric name"
              />
              <button className="btn primary sm" onClick={() => void renameMetric()}>Save</button>
              <button className="btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button>
            </span>
          ) : (
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              {saved.name}
              {/* Rename must be DISCOVERABLE — a labelled button (mirrors the Data tab). The
                  physical Cube member stays frozen; only the display label changes. */}
              {canManage ? (
                <button
                  className="btn ghost sm"
                  style={{ flex: 'none' }}
                  onClick={() => { setNameDraft(saved.name); setRenameErr(''); setRenaming(true); }}
                  title="Rename this metric (the Cube member stays stable)"
                  aria-label="Rename this metric"
                >✎ Rename</button>
              ) : null}
            </h2>
          )}
          <span className={`badge ${TIER_BADGE[saved.tier]}`}>{TIER_WORD[saved.tier]}</span>
          {(saved.tier === 'domain' || saved.tier === 'marketplace') ? <DomainTag domain={saved.domain} /> : null}
          <span className="muted mono" style={{ fontSize: 12 }}>{saved.member}</span>
          {renameErr ? <span className="error-inline" style={{ fontSize: 12 }}>{renameErr}</span> : null}
          {/* Header actions: View⇄Edit toggle · Promote (left of Archive, per the OS-wide
              pattern) · lifecycle (Archive/Restore/Delete). Governance unchanged (canManage). */}
          {canManage ? (
            <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {mode === 'view' ? (
                <button className="btn ghost sm" onClick={() => setMode('edit')} title="Edit this metric's definition">✎ Edit</button>
              ) : (
                <button className="btn ghost sm" onClick={() => setMode('view')} title="Back to the read view">View</button>
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
                  ? 'A metric shares its tier with its dataset: this lowers the underlying dataset — and every metric defined on it — from Company back to Domain. Nothing is deleted; you can promote again later.'
                  : 'A metric shares its tier with its dataset: this lowers the underlying dataset — and every metric defined on it — from Domain back to My. Nothing is deleted; you can promote again later.'}
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
                <span className="comp-label" style={{ margin: 0, marginTop: 6 }}>Source dataset</span>
                <DatasetPicker
                  value={datasetId}
                  onChange={setDatasetId}
                  selectedDeliverable={datasetId ? deliverable : null}
                />
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                A metric lives on a built Gold table — My, Domain or Company.
              </p>
            </div>

            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>Metric name</span>
              <input
                placeholder="e.g. Avg interactions per case"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                style={{ marginTop: 8, maxWidth: 320 }}
              />

              {/* A plain-language note captured up front, so the metric arrives with its
                  meaning already written. Optional; shown on the tile and in the Definition
                  panel. Suggest with AI proposes a draft here too. */}
              <span className="comp-label" style={{ margin: 0, marginTop: 14 }}>What does this metric mean?</span>
              <textarea
                placeholder="One or two plain sentences — e.g. Average number of agent interactions to resolve a case."
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
                rows={2}
                aria-label="Metric description"
                style={{ marginTop: 8, width: '100%', resize: 'vertical' }}
              />
              <p className="hint" style={{ marginTop: 6 }}>Optional.</p>
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
                label="AI reads this dataset's columns and fills the form from the metric name — you review before saving."
                cta="Suggest with AI"
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
              <span className="comp-label" style={{ margin: 0 }}>{isFormula ? 'Formula' : 'What to measure'}</span>
              {!isFormula ? (
              <>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <select value={form.aggregation} onChange={(e) => set({ aggregation: e.target.value })} style={{ minWidth: 220 }}>
                  {AGGREGATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
                {needsColumn ? (
                  <select
                    value={columns.includes(form.column) ? form.column : ''}
                    onChange={(e) => set({ column: e.target.value })}
                    disabled={!datasetId || columns.length === 0}
                    style={{ minWidth: 200 }}
                  >
                    <option value="">{columns.length === 0 ? 'no columns — document them in Data' : 'of column…'}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : null}
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                {AGGREGATIONS.find((a) => a.value === form.aggregation)?.hint}
              </p>

              {/* Narrowest-dataset guidance: if the column you need isn't on THIS dataset,
                  the honest fix is a curated (joined) dataset in Data — never an invented
                  join here. Shown when an aggregation needs a column the dataset lacks. */}
              {needsColumn && datasetId && columns.length === 0 ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  No documented columns here — build a <strong>curated dataset</strong> in Data and define the metric on that.
                </p>
              ) : null}
              </>
              ) : null}

              {isRatio ? (
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  <span className="hint" style={{ margin: 0 }}>Divide</span>
                  <select value={form.ratio.numerator} onChange={(e) => set({ ratio: { ...form.ratio, numerator: e.target.value } })} disabled={measures.length === 0} style={{ minWidth: 160 }}>
                    <option value="">numerator…</option>
                    {measures.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                  <span className="hint" style={{ margin: 0 }}>by</span>
                  <select value={form.ratio.denominator} onChange={(e) => set({ ratio: { ...form.ratio, denominator: e.target.value } })} disabled={measures.length === 0} style={{ minWidth: 160 }}>
                    <option value="">denominator…</option>
                    {measures.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                  {measures.length === 0 ? <span className="hint" style={{ margin: 0 }}>define the two base measures first</span> : null}
                </div>
              ) : null}

              {isFormula ? (
                !datasetId ? (
                  <p className="hint" style={{ marginTop: 10 }}>Choose a source dataset first.</p>
                ) : basicMeasures.length === 0 ? (
                  /* Honest empty state — a formula has nothing to reference until this
                     dataset has at least one basic metric. Don't offer a dead editor. */
                  <p className="hint" style={{ marginTop: 10 }}>
                    This dataset has no metrics yet — create a <strong>simple metric</strong> first, then combine them here.
                  </p>
                ) : (
                <div style={{ marginTop: 10 }}>
                  {/* The dataset's EXISTING basic metrics — click a chip to insert [name];
                      free typing works too. */}
                  <span className="hint" style={{ display: 'block' }}>
                    Click a metric to insert it — <code>+ - * /</code> and parentheses; division is null-safe (÷0 → empty, never an error).
                  </span>
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {basicMeasures.map((m) => (
                      <button
                        key={m.name}
                        type="button"
                        className="chip"
                        style={{ cursor: 'pointer' }}
                        onClick={() => set({ formula: `${form.formula}${form.formula && !form.formula.endsWith(' ') ? ' ' : ''}[${m.name}]` })}
                        title={`Insert [${m.name}] (${m.type})`}
                      >
                        [{m.name}] <span className="mono" style={{ opacity: 0.7 }}>{m.type}</span>
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="mono"
                    rows={2}
                    placeholder="([revenue] - [cost]) / [orders]"
                    value={form.formula}
                    onChange={(e) => set({ formula: e.target.value })}
                    style={{ width: '100%', resize: 'vertical', marginTop: 8 }}
                    aria-label="Composite metric formula"
                  />
                  {/* Live validation — inline error as you type, or the resolved refs as
                      ok-chips when valid. Preview only; the server stays authoritative. */}
                  {formulaCheck.error ? (
                    <span className="error-inline" role="alert" style={{ display: 'block', marginTop: 6 }}>{formulaCheck.error}</span>
                  ) : formulaCheck.refs?.length ? (
                    <div className="chip-row" style={{ marginTop: 6 }}>
                      {formulaCheck.refs.map((r) => (
                        <span key={r} className="chip ok" title={`[${r}] resolves to a basic metric on this dataset`}>[{r}] ✓</span>
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
              <span className="comp-label" style={{ margin: 0 }}>Filter (optional)</span>
              <div style={{ marginTop: 10 }}>
                <label className="chk" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.filter.on} onChange={(e) => set({ filter: { ...form.filter, on: e.target.checked } })} />
                  Only count rows where…
                </label>
                {form.filter.on ? (
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <select value={form.filter.column} onChange={(e) => set({ filter: { ...form.filter, column: e.target.value } })} disabled={columns.length === 0} style={{ minWidth: 160 }}>
                      <option value="">column…</option>
                      {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select value={form.filter.operator} onChange={(e) => set({ filter: { ...form.filter, operator: e.target.value } })}>
                      {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {form.filter.operator !== 'set' && form.filter.operator !== 'notSet' ? (
                      <input placeholder="value" value={form.filter.value} onChange={(e) => set({ filter: { ...form.filter, value: e.target.value } })} style={{ maxWidth: 160 }} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            )}

            {/* Time window — likewise not carried by a formula; hidden, not dropped. */}
            {isFormula ? null : (
            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>Time window</span>
              <div className="seg" style={{ marginTop: 8 }}>
                <button className={form.windowMode === 'none' ? 'on' : ''} onClick={() => set({ windowMode: 'none' })}>None</button>
                <button className={form.windowMode === 'running' ? 'on' : ''} onClick={() => set({ windowMode: 'running' })}>Running total</button>
                <button className={form.windowMode === 'trailing' ? 'on' : ''} onClick={() => set({ windowMode: 'trailing' })}>Trailing window</button>
              </div>
              {form.windowMode === 'trailing' ? (
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <span className="hint" style={{ margin: 0 }}>last</span>
                  <input type="number" min={1} value={form.windowAmount} onChange={(e) => set({ windowAmount: Math.max(1, Number(e.target.value) || 1) })} style={{ maxWidth: 80 }} />
                  <select value={form.windowUnit} onChange={(e) => set({ windowUnit: e.target.value as Form['windowUnit'] })}>
                    {WINDOW_UNITS.map((u) => <option key={u} value={u}>{u}s</option>)}
                  </select>
                </div>
              ) : form.windowMode === 'running' ? (
                <p className="hint" style={{ marginTop: 6 }}>Cumulative from the beginning of time.</p>
              ) : null}
            </div>
            )}

            {/* Format + slice */}
            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>Format &amp; dimensions</span>
              <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 10 }}>
                <span className="hint" style={{ margin: 0 }}>Display as</span>
                <select value={form.format} onChange={(e) => set({ format: e.target.value })}>
                  {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              {sliceMembers.length > 0 ? (
                <>
                  <span className="hint" style={{ marginTop: 12, display: 'block' }}>Slice by (optional)</span>
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
                  <span className="hint" style={{ margin: 0 }}>Over time</span>
                  <select value={form.timeDimension} onChange={(e) => set({ timeDimension: e.target.value })} style={{ minWidth: 160 }}>
                    <option value="">not by time</option>
                    {timeColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {form.timeDimension ? (
                    <select value={form.granularity} onChange={(e) => set({ granularity: e.target.value as Form['granularity'] })}>
                      {GRAINS.map((g) => <option key={g} value={g}>by {g}</option>)}
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
                {busy ? <span className="spin" /> : saved ? 'Save changes' : 'Save metric'}
              </button>
              <span className="hint" style={{ margin: 0 }}>
                {saved ? 'Updates in place — dashboards and alerts keep working.' : 'Serves within ~30 s.'}
              </span>
            </div>
            {busy ? (
              <BusyProgress
                label={saved ? 'Saving changes' : 'Saving metric'}
                detail="Persisting the definition, proving the define paths converge, then building and verifying it against the live query engine"
                typicalSeconds={30}
              />
            ) : null}
            {saveErr ? <div className="error" style={{ marginTop: 10 }}>{saveErr}</div> : null}
          </div>
        </div>

      ) : saved ? (
        /* ── View — read-first, LEADING with Talk (the OS-wide contract, mirroring Data):
              Talk to Metrics · definition · governed SQL · data underneath · usable
              dimensions · live preview · Alerts ── */
        <div>
          {/* 1. Talk to this metric — the primary way to USE it, at the very top of View. */}
          <div className="section-title" style={{ marginTop: 4 }}>{TALK_PRESENTATION.metrics.title}</div>
          <TalkTo tab="metrics" {...TALK_PRESENTATION.metrics} />

          {/* Definition in plain terms + the data underneath */}
          <div className="guided-panel" style={{ marginTop: 28 }}>
            <span className="comp-label" style={{ margin: 0 }}>Definition</span>
            {/* The author's plain-language meaning leads when present; the technical
                one-liner (aggregation · filter · window) then supports it underneath. */}
            {form.description.trim() ? (
              <p className="lead" style={{ marginTop: 8, marginBottom: 0 }}>{form.description.trim()}</p>
            ) : null}
            <p className={form.description.trim() ? 'hint' : 'lead'} style={{ marginTop: form.description.trim() ? 10 : 8, marginBottom: 0 }}>{describeDefinition(form)}</p>
            <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
              On <strong>{saved.datasetName || saved.datasetId}</strong>
              {datasetTier ? <> · {datasetLayerLabel(datasetTier)}</> : null} — served as <code>{saved.member}</code>.
            </p>
            {sliceMembers.length > 0 ? (
              <>
                <span className="hint" style={{ marginTop: 12, display: 'block' }}>Dimensions you can slice by</span>
                <div className="chip-row" style={{ marginTop: 6 }}>
                  {sliceMembers.map((c) => <span key={c} className="chip">{c}</span>)}
                </div>
              </>
            ) : null}
          </div>

          {/* How it is calculated — the governed Trino SQL the number comes from */}
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>How it is calculated</span>
            {preview?.sql ? (
              <pre className="codeblock" style={{ marginTop: 10 }}>{preview.sql}</pre>
            ) : preview?.pending ? (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                Syncing — the query engine picks this metric up within ~30 s.
              </p>
            ) : (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                {previewBusy ? 'Resolving the governed SQL…' : previewErr || 'The governed SQL appears once the metric resolves.'}
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
          <div className="section-title" style={{ marginTop: 28 }}>Alerts</div>
          <Alerts metrics={metrics} loading={metricsLoading} presetMember={saved.member} />

          {/* Connect Power BI is REMOVED from View for now — the connection is unverified;
              restore <ConnectPowerBI domain={saved.domain} /> once it is proven working. */}
        </div>
      ) : (
        <div className="chat-empty">Nothing to view yet — define the metric first.</div>
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
        <span className="comp-label" style={{ margin: 0 }}>On dashboards</span>
        <Link className="btn ghost sm" href={addHref} title="Open the Dashboards builder with this metric pre-selected">
          ＋ Add to a dashboard
        </Link>
      </div>
      {dashboards === null ? (
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>Loading dashboards…</p>
      ) : dashboards.length === 0 ? (
        <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
          No dashboard charts this metric yet — add it to one to see it live alongside its siblings.
        </p>
      ) : (
        <div className="chip-row" style={{ marginTop: 8 }}>
          {dashboards.map((d) => (
            <Link
              key={d.id}
              className="chip"
              href={`/dashboards?focus=${encodeURIComponent(d.id)}`}
              title={`Open ${d.name}`}
              style={{ cursor: 'pointer' }}
            >
              {d.name} <span className="mono" style={{ opacity: 0.7 }}>{d.charts} panel{d.charts === 1 ? '' : 's'}</span>
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
  if (result?.cube) {
    return (
      <div className="grant-block" style={{ marginTop: 4 }}>
        <div className="comp-label">Cube model YAML</div>
        <p className="hint" style={{ marginTop: 4 }}>Read-only — the generated measure block.</p>
        <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {result.cube}
        </pre>
        {result.member ? (
          <p className="hint" style={{ marginTop: 8 }}>
            Canonical member: <code>{result.member}</code>
            {result.build?.mode ? <> · mode: <span className={`badge ${result.build.mode === 'live' ? 'ok' : 'muted'}`}>{result.build.mode}</span></> : null}
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
      <div className="comp-label">Cube measure payload (preview)</div>
      <p className="hint" style={{ marginTop: 4 }}>Not saved yet — the config that will be submitted:</p>
      {preview ? (
        <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
          {JSON.stringify(preview, null, 2)}
        </pre>
      ) : (
        <p className="hint" style={{ marginTop: 8 }}>
          Pick a dataset and fill the form to see the payload preview.
        </p>
      )}
    </div>
  );
}
