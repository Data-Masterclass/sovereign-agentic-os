/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import StageShell from '@/components/core/StageShell';
import { initialStageState, markDone, type StageState } from '@/lib/core/stages';
import { METRIC_STAGES, type MetricCtx, type MetricStageId } from '@/lib/metrics/stages';
import { useToast } from '@/components/core/Toast';
import MetricStageAssistant from './MetricStageAssistant';
import ExploreMetric from './ExploreMetric';
import Alerts from './Alerts';
import {
  type DatasetGroups,
  type DefineResult,
  type MetricGroups,
  type MetricSummary,
  BuildRowsView,
  ChecksList,
  TIER_BADGE,
  TIER_WORD,
  leaf,
} from './shared';

/* ─────────────────────────────── constants ─────────────────────────────── */

const AGGREGATIONS: { value: string; label: string; hint: string }[] = [
  { value: 'count', label: 'Count of rows', hint: 'how many records' },
  { value: 'count_distinct', label: 'Count of unique values', hint: 'distinct values in a column' },
  { value: 'count_distinct_approx', label: 'Count of unique (fast, approximate)', hint: 'HyperLogLog — huge datasets' },
  { value: 'sum', label: 'Sum', hint: 'total of a numeric column' },
  { value: 'avg', label: 'Average', hint: 'mean of a numeric column' },
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
  aggregation: string;
  column: string;
  dimensions: string[];
  filter: { on: boolean; column: string; operator: string; value: string };
  windowMode: WindowMode;
  windowAmount: number;
  windowUnit: (typeof WINDOW_UNITS)[number];
  ratio: { numerator: string; denominator: string };
  format: string;
  timeDimension: string;
  granularity: (typeof GRAINS)[number];
};

const EMPTY_FORM: Form = {
  name: '',
  aggregation: 'sum',
  column: '',
  dimensions: [],
  filter: { on: false, column: '', operator: 'equals', value: '' },
  windowMode: 'none',
  windowAmount: 7,
  windowUnit: 'day',
  ratio: { numerator: '', denominator: '' },
  format: '',
  timeDimension: '',
  granularity: 'month',
};

type Column = { name: string };
type Measure = { name: string; type: string };

type PreviewResult = {
  member: string;
  rows: Record<string, unknown>[];
  mode: 'live' | 'offline-mock';
  pending?: boolean;
};

/** Metric tier → lifecycle visibility (drives delete gate). */
const lcVis = (tier: MetricSummary['tier']): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';
/** Metric tier → the PromoteButton's ladder tier. */
const ladderTier = (tier: MetricSummary['tier']): PromoteTier =>
  tier === 'domain' ? 'Shared' : tier === 'marketplace' ? 'Marketplace' : 'Personal';

/* ─────────────────────────── sub-hooks ─────────────────────────────────── */

function useDataset(datasetId: string) {
  const [state, setState] = useState({ columns: [] as string[], measures: [] as Measure[], deliverable: true });
  useEffect(() => {
    if (!datasetId) { setState({ columns: [], measures: [], deliverable: true }); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
        const data = await res.json();
        if (live && res.ok) {
          const ds = data?.dataset ?? {};
          const cols = (ds.columns ?? []) as Column[];
          const ms = (ds.measures ?? []) as Measure[];
          const deliverable = ds.tier !== 'dataset' && Boolean(ds?.versions?.gold?.built);
          setState({ columns: cols.map((c) => c.name).filter(Boolean), measures: ms, deliverable });
        }
      } catch { if (live) setState({ columns: [], measures: [], deliverable: true }); }
    })();
    return () => { live = false; };
  }, [datasetId]);
  return state;
}

/* ─────────────────────────── small pieces ──────────────────────────────── */

function DatasetPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [groups, setGroups] = useState<DatasetGroups | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/data/datasets', { cache: 'no-store' });
        if (res.ok) setGroups(await res.json());
      } catch { /* surfaced by the define call */ }
    })();
  }, []);
  const all = groups ? [...groups.mine, ...groups.domain, ...groups.marketplace] : [];
  const tierLabel = { dataset: 'private', asset: 'asset', product: 'product' } as const;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 260 }}>
      <option value="">choose a dataset…</option>
      {all.map((d) => <option key={d.id} value={d.id}>{d.name} · {tierLabel[d.tier]}</option>)}
    </select>
  );
}

function toPayload(form: Form) {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    aggregation: form.aggregation,
    column: form.column.trim(),
    dimensions: form.dimensions,
  };
  if (form.filter.on && form.filter.column) {
    payload.filter = { column: form.filter.column, operator: form.filter.operator, value: form.filter.value };
  }
  if (form.windowMode === 'running') payload.runningTotal = true;
  else if (form.windowMode === 'trailing') payload.rollingWindow = { amount: form.windowAmount, unit: form.windowUnit };
  if (form.aggregation === 'number') payload.ratio = { numerator: form.ratio.numerator.trim(), denominator: form.ratio.denominator.trim() };
  if (form.format) payload.format = form.format;
  return payload;
}

/* ──────────────────────────── main component ───────────────────────────── */

/**
 * The Metrics guided builder — Define · Refine · Preview · Publish · Monitor on the
 * OS-wide staged primitive (lib/core/stages.ts + StageShell). Creating AND viewing a
 * metric share ONE flow: a fresh metric starts at Define and walks forward as state
 * settles; an existing metric opens at Monitor. Reuses existing pieces as stage bodies
 * (ExploreMetric, Alerts, PromoteButton, LifecycleActions) without rewriting them.
 */
export default function MetricBuilder({
  existing,
  metrics,
  metricsLoading,
  onBack,
  onChanged,
}: {
  /** Open an existing saved metric (lands at Monitor), or null to create a new one (Define). */
  existing: MetricSummary | null;
  metrics: MetricGroups | null;
  metricsLoading: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { user } = useUser();
  const toast = useToast();

  /* ── form state ── */
  const [datasetId, setDatasetId] = useState('');
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [usedAgent, setUsedAgent] = useState(false);
  const { columns, measures, deliverable } = useDataset(datasetId);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const isRatio = form.aggregation === 'number';
  const needsColumn = !isRatio && form.aggregation !== 'count';

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
      : isRatio
        ? form.ratio.numerator.trim() !== '' && form.ratio.denominator.trim() !== ''
        : form.column.trim() !== '');

  /* ── stage state ── */
  const ctx: MetricCtx = {
    defined: datasetId !== '' && form.name.trim() !== '',
    refined: canSubmit,
    previewed: !!preview && !preview.pending && preview.rows.length > 0,
    saved: !!existing || !!result,
  };

  const [stage, setStage] = useState<StageState<MetricStageId>>(() => {
    const base = initialStageState(METRIC_STAGES);
    return existing ? { ...base, current: 'monitor' } : base;
  });

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
      const p: PreviewResult = { member: data.member, rows: data.rows ?? [], mode: data.mode, pending: data.pending };
      setPreview(p);
      // Mark preview done in-stage once we get a live non-pending result.
      if (!p.pending && p.rows.length > 0) {
        setStage((s) => markDone(s, 'preview'));
      }
    } catch (e) { setPreviewErr((e as Error).message); setPreview(null); } finally { setPreviewBusy(false); }
  }, [canSubmit, datasetId, form]);

  // Auto-poll while pending — up to 6 times (30 s total, 5 s interval).
  useEffect(() => {
    if (!preview?.pending) return;
    let tries = 0;
    const MAX = 6;
    const id = setInterval(async () => {
      tries++;
      await runPreview();
      if (tries >= MAX) clearInterval(id);
    }, 5000);
    return () => clearInterval(id);
  }, [preview?.pending, runPreview]);

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
      setStage((s) => markDone(s, 'publish'));
      onChanged();
    } catch (e) { const msg = (e as Error).message; setSaveErr(msg); toast.error(msg); } finally { setBusy(false); }
  }, [datasetId, form, usedAgent, onChanged, toast]);

  /* ── governance ── */
  const canManage = !!user && !!saved && canManageArtifact(user, { owner: saved.owner, domain: saved.domain ?? '' });
  const canApprove = !!user && roleAtLeast(user.role, 'builder');
  const onLifecycle = () => { onChanged(); onBack(); };

  const previewCols = preview && preview.rows.length ? Object.keys(preview.rows[0]) : [];

  /* ── render ── */
  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All metrics</button>

      {saved ? (
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{saved.name}</h2>
          <span className={`badge ${TIER_BADGE[saved.tier]}`}>{TIER_WORD[saved.tier]}</span>
          {(saved.tier === 'domain' || saved.tier === 'marketplace') ? <DomainTag domain={saved.domain} /> : null}
          <span className="muted mono" style={{ fontSize: 12 }}>{saved.member}</span>
          {/* Lifecycle (Archive/Restore/Delete) lives in the persistent detail header so it is
              reachable from ANY stage — not buried in Publish. Governance unchanged (canManage). */}
          {canManage ? (
            <div style={{ marginLeft: 'auto' }}>
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

      <StageShell
        stages={METRIC_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Metric stages"
        assistant={(st) => {
          if (st.id === 'define') {
            return (
              <MetricStageAssistant
                stage="define"
                label="Describe your metric in words — the assistant will fill the form."
                cta="Propose from goal →"
                disabled={!datasetId || columns.length === 0}
                payload={() => ({ goal: `define a metric on this dataset`, columns })}
                onForm={(f) => {
                  if (f.name) set({ name: f.name });
                  if (f.aggregation && AGGREGATIONS.some((a) => a.value === f.aggregation)) set({ aggregation: f.aggregation });
                  if (f.column && columns.includes(f.column)) set({ column: f.column });
                  if (Array.isArray(f.dimensions)) set({ dimensions: f.dimensions.filter((d) => columns.includes(d)) });
                  setUsedAgent(true);
                }}
              />
            );
          }
          if (st.id === 'refine') {
            return (
              <MetricStageAssistant
                stage="refine"
                label="Suggest dimensions, filters and time window for this metric."
                cta="Suggest refinements"
                disabled={!form.name.trim() || columns.length === 0}
                payload={() => ({ metricName: form.name, aggregation: form.aggregation, columns })}
              />
            );
          }
          if (st.id === 'preview') {
            return (
              <MetricStageAssistant
                stage="preview"
                label="Explain a preview error or pending state in plain language."
                cta="Explain the status"
                disabled={!previewErr && !preview?.pending}
                payload={() => ({ error: previewErr || (preview?.pending ? 'The metric is still syncing to the query engine.' : '') })}
              />
            );
          }
          if (st.id === 'publish') {
            return (
              <MetricStageAssistant
                stage="publish"
                label="Draft a promotion justification for this metric."
                cta="Draft justification"
                disabled={!saved}
                payload={() => ({ metricName: saved?.name ?? form.name, tier: saved ? TIER_WORD[saved.tier] : 'Personal' })}
              />
            );
          }
          // monitor
          return (
            <MetricStageAssistant
              stage="monitor"
              label="Suggest an alert threshold based on what this metric measures."
              cta="Suggest threshold"
              disabled={!saved}
              payload={() => ({ metricName: saved?.name ?? '', historyHint: '' })}
            />
          );
        }}
      >
        {/* ── Define ── */}
        {stage.current === 'define' ? (
          <div>
            <p className="lead" style={{ marginTop: 4 }}>
              Pick a governed dataset and name your metric. Use the assistant above to
              describe it in words — the form fills automatically, ready for you to review.
            </p>

            <div className="guided-panel">
              <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="comp-label" style={{ margin: 0 }}>Source dataset</span>
                <DatasetPicker value={datasetId} onChange={setDatasetId} />
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                A metric lives on a governed Gold <strong>asset</strong> or <strong>product</strong>.
                Pick a private dataset and promote it in Data first.
              </p>
              {datasetId && !deliverable ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  Heads up: promote this dataset to <strong>Shared</strong> and build <strong>Gold</strong> so
                  its metrics reach the query engine — you can still define now.
                </p>
              ) : null}
            </div>

            <div className="guided-panel" style={{ marginTop: 14 }}>
              <span className="comp-label" style={{ margin: 0 }}>Metric name</span>
              <input
                placeholder="e.g. Revenue"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                style={{ marginTop: 8, maxWidth: 280 }}
              />
              <p className="hint" style={{ marginTop: 6 }}>
                This becomes the canonical name in the registry, explorer and dashboards.
              </p>
            </div>
          </div>
        ) : null}

        {/* ── Refine ── */}
        {stage.current === 'refine' ? (
          <div>
            {/* Aggregation + column */}
            <div className="guided-panel" style={{ marginTop: 4 }}>
              <span className="comp-label" style={{ margin: 0 }}>What to measure</span>
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
            </div>

            {/* Filter */}
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

            {/* Time window */}
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
          </div>
        ) : null}

        {/* ── Preview ── */}
        {stage.current === 'preview' ? (
          <div>
            <div className="guided-panel" style={{ marginTop: 4 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <span className="comp-label" style={{ margin: 0 }}>Live number</span>
                  <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
                    Runs the exact governed query your saved metric will resolve, under your own identity.
                    Row-level security applies. Nothing is saved yet.
                  </p>
                </div>
                <button className="btn ghost" onClick={runPreview} disabled={previewBusy || !canSubmit} style={{ marginLeft: 12 }}>
                  {previewBusy ? <span className="spin" /> : preview ? 'Re-run preview' : 'Preview →'}
                </button>
              </div>

              {previewErr ? <div className="error" style={{ marginTop: 10 }}>{previewErr}</div> : null}

              {preview ? (
                preview.pending ? (
                  <div className="stub-page" style={{ marginTop: 10 }}>
                    Syncing — the live value appears within ~30 s as the query engine picks up
                    this metric. Re-run preview shortly, or wait for the auto-refresh.
                  </div>
                ) : preview.rows.length === 0 ? (
                  <div className="stub-page" style={{ marginTop: 10 }}>
                    No rows for you under the current filter.
                  </div>
                ) : (
                  <>
                    <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
                      <span className={`badge ${preview.mode === 'live' ? 'ok' : 'muted'}`}>{preview.mode}</span>
                      <span className="muted mono" style={{ fontSize: 12 }}>{preview.member}</span>
                    </div>
                    <div className="table-wrap" style={{ marginTop: 10 }}>
                      <table>
                        <thead><tr>{previewCols.map((c) => <th key={c}>{leaf(c)}</th>)}</tr></thead>
                        <tbody>
                          {preview.rows.slice(0, 20).map((r, i) => (
                            <tr key={i}>{previewCols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
              ) : (
                <div className="stub-page" style={{ marginTop: 10 }}>
                  Click Preview → to see the live value.
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* ── Publish ── */}
        {stage.current === 'publish' ? (
          <div>
            {!saved ? (
              <>
                <div className="guided-panel" style={{ marginTop: 4 }}>
                  <p className="hint" style={{ marginTop: 0 }}>
                    Ready to save <strong>{form.name || 'this metric'}</strong>? The definition will be
                    persisted and the query engine will pick it up within ~30 s.
                  </p>

                  {/* Cube config preview */}
                  <div className="section-title" style={{ marginTop: 10 }}>Cube measure config</div>
                  <pre className="codeblock">{JSON.stringify(toPayload(form), null, 2)}</pre>

                  <div className="row" style={{ marginTop: 14 }}>
                    <button className="btn" onClick={submit} disabled={!canSubmit || busy}>
                      {busy ? <span className="spin" /> : 'Save metric'}
                    </button>
                  </div>
                  {saveErr ? <div className="error" style={{ marginTop: 10 }}>{saveErr}</div> : null}
                </div>

                {result ? (
                  <div style={{ marginTop: 14 }}>
                    {result.pending ? (
                      <div className="stub-page" style={{ marginBottom: 14 }}>
                        ✓ Metric saved — its live value appears within ~30 s as the query engine syncs.
                      </div>
                    ) : null}
                    <div className="section-title">Convergence · form and agent resolve to one measure</div>
                    <ChecksList rows={result.convergence.rows} />
                    <div className="section-title">Build · apply → verify</div>
                    <BuildRowsView build={result.build} />
                    <p className="hint" style={{ marginTop: 8 }}>
                      Canonical member <code>{result.member}</code> — the single number the explorer,
                      dashboards and the assistant all resolve.
                    </p>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                {/* Saved metric — show promote/lifecycle */}
                <div className="guided-panel" style={{ marginTop: 4 }}>
                  <p className="hint" style={{ marginTop: 0 }}>
                    <strong>{saved.name}</strong> is saved as <strong>{TIER_WORD[saved.tier]}</strong>.
                    Promote it to make it available to your domain.
                  </p>

                  {canManage ? (
                    <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                      <PromoteButton
                        id={saved.id}
                        kind="metric"
                        tier={ladderTier(saved.tier)}
                        promoteUrl={`/api/metrics/${saved.id}/promote`}
                        canApprove={canApprove}
                        onDone={onChanged}
                      />
                      {/* Archive/Restore/Delete now live in the persistent detail header (reachable
                          from any stage); Publish keeps only Promote. */}
                    </div>
                  ) : (
                    <p className="hint" style={{ marginTop: 10 }}>
                      You can view this metric. Promotion and archiving are limited to its owner and domain admins.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* ── Monitor ── */}
        {stage.current === 'monitor' ? (
          saved ? (
            <div>
              {/* Explore */}
              <div style={{ marginTop: 4 }}>
                <ExploreMetric metric={saved} />
              </div>

              {/* Alerts */}
              <div className="section-title" style={{ marginTop: 28 }}>Alerts</div>
              <p className="lead" style={{ marginTop: 0 }}>
                Notify me when <strong>{saved.member}</strong> crosses a threshold — and optionally
                trigger a governed agent to respond.
              </p>
              <Alerts metrics={metrics} loading={metricsLoading} presetMember={saved.member} />
            </div>
          ) : (
            <div className="chat-empty">Save the metric first — there is nothing to monitor yet.</div>
          )
        ) : null}
      </StageShell>
    </ConfirmProvider>
  );
}
