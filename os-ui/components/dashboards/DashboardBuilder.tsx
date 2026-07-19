/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import StageShell from '@/components/core/StageShell';
import { initialStageState, isSatisfied, markDone, goTo, advance, type StageState } from '@/lib/core/stages';
import { DASH_STAGES, type DashStageId, type DashCtx } from '@/lib/dashboards/stages';
import EmbedPanel from './EmbedPanel';
import Reports from './Reports';
import StageAssistant from './StageAssistant';
import {
  flatMetrics, postJson, slug, VIZ_TYPES,
  type BuildResponse, type ChartSpec, type DashboardSummary, type DashTier,
  type MetricGroups, type MetricSummary, type VizType,
  TIER_BADGE, TIER_LABEL,
} from './shared';

/** The Cube view a chart's member belongs to (member = `View.measure`). */
const viewOfMetric = (m: string) => (m.includes('.') ? m.slice(0, m.indexOf('.')) : m);

/** Dashboard tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: DashTier): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';
/** Dashboard tier → the shared ladder tier the PromoteButton speaks. */
const ladderTier = (tier: DashTier): PromoteTier =>
  tier === 'domain' ? 'Shared' : tier === 'marketplace' ? 'Marketplace' : 'Personal';

/**
 * The Dashboards guided builder — Define · Design · Build · View · Govern on the OS-wide
 * staged primitive (lib/core/stages.ts + components/core/StageShell.tsx; the Agents
 * SimpleBuilder is the reference adoption). Creating AND viewing are ONE flow: a fresh
 * dashboard starts on Define and walks forward as its real state settles (charts → build →
 * embed → persisted); an EXISTING dashboard is already built + persisted, so it opens at
 * View. Each stage reuses the tab's existing bodies as-is (chart adder, EmbedPanel,
 * Reports, PromoteButton, LifecycleActions) — nothing is rewritten, only re-hosted.
 */
export default function DashboardBuilder({
  existing,
  metrics,
  metricsLoading,
  onBack,
  onChanged,
}: {
  /** Open an already-built dashboard (lands at View), or null to create a new one (Define). */
  existing: DashboardSummary | null;
  metrics: MetricGroups | null;
  metricsLoading: boolean;
  onBack: () => void;
  /** Refresh the list after a build/archive/restore/version; delete returns to the list. */
  onChanged: () => void;
}) {
  const { user } = useUser();
  const palette = useMemo(() => flatMetrics(metrics), [metrics]);

  // Draft-in-progress state (new dashboards). An existing dashboard seeds name/view but
  // has no client-side chart specs (the list returns a count only) — it's already built.
  const [name, setName] = useState(existing?.name ?? '');
  const [charts, setCharts] = useState<ChartSpec[]>([]);
  const [build, setBuild] = useState<BuildResponse | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildErr, setBuildErr] = useState('');
  const [viewed, setViewed] = useState(false);
  const [liveRls, setLiveRls] = useState('');

  // The persisted dashboard we govern/view: the freshly-built one, or the one we opened.
  const built: DashboardSummary | null = useMemo(() => {
    if (existing) return existing;
    if (build?.build.ok) {
      return {
        id: build.id,
        name: build.spec.name,
        view: build.spec.view,
        tier: 'personal',
        owner: user?.name ?? '',
        charts: build.spec.charts.length,
      };
    }
    return null;
  }, [existing, build, user?.name]);

  // The single Cube view the charts bind to (a dashboard binds to exactly one).
  const views = useMemo(
    () => Array.from(new Set(charts.map((c) => viewOfMetric(c.metric)).filter(Boolean))),
    [charts],
  );
  const view = existing?.view ?? views[0] ?? '';
  const multiView = views.length > 1;

  // The live ctx the stage gates/✓ read — real dashboard state, never faked.
  const ctx: DashCtx = {
    defined: !!existing || (!!name.trim() && charts.length > 0 && !!view),
    hasCharts: !!existing || (charts.length > 0 && !multiView),
    builtOk: !!existing || !!build?.build.ok,
    viewed: !!existing || viewed,
    persisted: !!built,
  };

  // Open on the first REACHABLE stage: a new dashboard on Define, an existing one on View.
  const [stage, setStage] = useState<StageState<DashStageId>>(() => {
    const base = initialStageState(DASH_STAGES);
    return existing ? { ...base, current: 'view' } : base;
  });

  const addChart = (m: MetricSummary) =>
    setCharts((cs) => [...cs, { name: m.name, vizType: 'big_number_total', metric: m.member }]);
  const updateChart = (i: number, patch: Partial<ChartSpec>) =>
    setCharts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeChart = (i: number) => setCharts((cs) => cs.filter((_, j) => j !== i));

  const runBuild = async () => {
    setBuildErr('');
    setBuild(null);
    const trimmed = name.trim();
    if (!trimmed) return setBuildErr('Give the dashboard a name.');
    if (charts.length === 0) return setBuildErr('Add at least one chart on a governed metric.');
    if (multiView) return setBuildErr(`A dashboard binds to one Cube view — these charts span ${views.join(', ')}. Keep charts from a single view.`);
    setBuilding(true);
    try {
      const res = await postJson<BuildResponse>('/api/dashboards/build', {
        id: `${slug(trimmed) || 'dashboard'}-${Math.random().toString(36).slice(2, 8)}`,
        name: trimmed,
        view,
        mode: 'drag-drop',
        charts,
      });
      setBuild(res);
      onChanged();
      // Build settles in-stage → record its ✓ (gated on the live condition, like Agents).
      if (res.build.ok) setStage((s) => markDone(s, 'build'));
    } catch (e) {
      setBuildErr((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  const go = (id: DashStageId) => setStage((s) => goTo(DASH_STAGES, s, id, ctx));
  const next = () => setStage((s) => advance(DASH_STAGES, s, ctx));

  const canManage = !!user && !!built && canManageArtifact(user, { owner: built.owner, domain: built.domain ?? '' });
  const canApprove = !!user && roleAtLeast(user.role, 'builder');

  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All dashboards</button>

      {built ? (
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{built.name}</h2>
          {(built.tier === 'domain' || built.tier === 'marketplace') ? <DomainTag domain={built.domain} /> : null}
          <span className={`badge ${TIER_BADGE[built.tier]}`}>{TIER_LABEL[built.tier]}</span>
          <span className="muted mono" style={{ fontSize: 12 }}>{built.view}</span>
        </div>
      ) : null}

      <StageShell
        stages={DASH_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Dashboard stages"
        assistant={(st) =>
          st.id === 'define' ? (
            <StageAssistant
              stage="define" label="Suggest a Cube view and starter charts from your goal." cta="Suggest a view"
              disabled={palette.length === 0}
              payload={() => ({ prompt: name, members: Array.from(new Set(palette.map((m) => viewOfMetric(m.member)))) })}
            />
          ) : st.id === 'design' ? (
            <StageAssistant
              stage="design" label="Suggest chart tiles from this view’s measures." cta="Suggest charts"
              disabled={!view || palette.length === 0}
              payload={() => ({ view, prompt: name, members: palette.filter((m) => viewOfMetric(m.member) === view).map((m) => m.member) })}
              onCharts={(cs) => setCharts(cs.filter((c) => VIZ_TYPES.includes(c.vizType as VizType) && palette.some((m) => m.member === c.metric)).map((c) => ({ name: c.name, vizType: c.vizType as VizType, metric: c.metric })))}
            />
          ) : st.id === 'build' ? (
            <StageAssistant
              stage="build" label="Explain a build or import failure in plain language." cta="Explain the failure"
              disabled={!build || build.build.ok}
              payload={() => ({ reason: build?.build.rows.find((r) => r.status === 'fail')?.error || build?.build.rows.find((r) => r.status === 'fail')?.detail || '' })}
            />
          ) : st.id === 'view' ? (
            <StageAssistant
              stage="view" label="Narrate what the current row-level-security clause filters." cta="Explain the filter"
              payload={() => ({ rls: liveRls })}
            />
          ) : (
            <StageAssistant
              stage="govern" label="Draft a promotion justification for this dashboard." cta="Draft justification"
              disabled={!built}
              payload={() => ({ name: built?.name, view: built?.view, tier: built ? TIER_LABEL[built.tier] : 'Personal' })}
            />
          )
        }
      >
        {stage.current === 'define' ? (
          <DefineStage
            name={name} setName={setName} view={view}
            palette={palette} loading={metricsLoading}
            charts={charts} addChart={addChart}
          />
        ) : null}

        {stage.current === 'design' ? (
          <DesignStage
            view={view} palette={palette} loading={metricsLoading}
            charts={charts} addChart={addChart} updateChart={updateChart} removeChart={removeChart}
            multiView={multiView} views={views}
          />
        ) : null}

        {stage.current === 'build' ? (
          <BuildStage
            name={name} building={building} error={buildErr} result={build}
            canBuild={!!name.trim() && charts.length > 0 && !multiView}
            onBuild={runBuild} onContinue={() => go('view')}
          />
        ) : null}

        {stage.current === 'view' && built ? (
          <div>
            <EmbedPanel
              dashboard={built}
              onEmbed={({ mode, rls }) => { setLiveRls(rls); setViewed(true); if (mode === 'live') setStage((s) => markDone(s, 'view')); }}
            />
            {!viewed ? null : (
              <p className="hint" style={{ marginTop: 10 }}>
                Viewed under your row-level security. Continue to Govern to report on, promote or archive it.
              </p>
            )}
          </div>
        ) : stage.current === 'view' ? (
          <div className="chat-empty">Build the dashboard first — there is nothing to view yet.</div>
        ) : null}

        {stage.current === 'govern' && built ? (
          <div>
            <div className="section-title">Reports</div>
            <Reports dashboard={built} />
            {canManage ? (
              <>
                <div className="section-title">Lifecycle</div>
                <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <PromoteButton
                    id={built.id}
                    kind="dashboard"
                    tier={ladderTier(built.tier)}
                    promoteUrl={`/api/dashboards/${built.id}/promote`}
                    canApprove={canApprove}
                    onDone={onChanged}
                  />
                  <LifecycleActions
                    id={built.id}
                    name={built.name}
                    kind="dashboard"
                    visibility={lcVis(built.tier)}
                    archived={!!built.archived}
                    api={`/api/dashboards/${built.id}`}
                    handlers={{ onDelete: async () => {
                      const res = await fetch(`/api/dashboards/${built.id}`, { method: 'DELETE' });
                      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Delete failed');
                      onChanged(); onBack();
                    } }}
                    onChanged={onChanged}
                    compact
                  />
                </div>
              </>
            ) : (
              <p className="hint">You can report on this dashboard. Promotion and archiving are limited to its owner and domain admins.</p>
            )}
          </div>
        ) : stage.current === 'govern' ? (
          <div className="chat-empty">Build the dashboard first — there is nothing to govern yet.</div>
        ) : null}
      </StageShell>
    </ConfirmProvider>
  );
}

/* ─────────────────────────── Define ─────────────────────────── */

function DefineStage({
  name, setName, view, palette, loading, charts, addChart,
}: {
  name: string;
  setName: (v: string) => void;
  view: string;
  palette: MetricSummary[];
  loading: boolean;
  charts: ChartSpec[];
  addChart: (m: MetricSummary) => void;
}) {
  return (
    <div className="agent-editor" style={{ marginTop: 4 }}>
      <label className="comp-label">Dashboard name</label>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales overview" />
      <div className="hint" style={{ marginTop: 6 }}>
        Cube view: <code>{view || '—'}</code> · id: <code>{slug(name) || '—'}</code> · a dashboard binds to ONE governed view.
      </div>

      <label className="comp-label" style={{ marginTop: 16 }}>Pick the view — click a governed metric to bind it</label>
      {loading && palette.length === 0 ? (
        <div className="hint">Loading metrics…</div>
      ) : palette.length === 0 ? (
        <div className="hint">No governed metrics yet — define one in the Metrics tab.</div>
      ) : (
        <div className="chip-row" style={{ marginTop: 4 }}>
          {palette.map((m) => (
            <button key={m.id} className="chip" style={{ cursor: 'pointer' }} onClick={() => addChart(m)} title={`Bind ${m.member}`}>
              {m.name} <span className="mono" style={{ opacity: 0.7 }}>{m.member}</span>
            </button>
          ))}
        </div>
      )}
      {charts.length > 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          Bound to <code>{view}</code> with {charts.length} starter chart{charts.length === 1 ? '' : 's'}. Refine them in Design →.
        </p>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Design ─────────────────────────── */

function DesignStage({
  view, palette, loading, charts, addChart, updateChart, removeChart, multiView, views,
}: {
  view: string;
  palette: MetricSummary[];
  loading: boolean;
  charts: ChartSpec[];
  addChart: (m: MetricSummary) => void;
  updateChart: (i: number, patch: Partial<ChartSpec>) => void;
  removeChart: (i: number) => void;
  multiView: boolean;
  views: string[];
}) {
  // Only offer members from the bound view (keeps the single-view guard visible up front).
  const inView = palette.filter((m) => !view || viewOfMetric(m.member) === view);
  return (
    <div className="agent-editor" style={{ marginTop: 4 }}>
      <label className="comp-label">Governed metrics on <code>{view || '—'}</code> — click to add a chart tile</label>
      {loading && palette.length === 0 ? (
        <div className="hint">Loading metrics…</div>
      ) : inView.length === 0 ? (
        <div className="hint">No metrics on this view — go back to Define to pick another.</div>
      ) : (
        <div className="chip-row" style={{ marginTop: 4 }}>
          {inView.map((m) => (
            <button key={m.id} className="chip" style={{ cursor: 'pointer' }} onClick={() => addChart(m)} title={`Add ${m.member}`}>
              {m.name} <span className="mono" style={{ opacity: 0.7 }}>{m.member}</span>
            </button>
          ))}
        </div>
      )}

      <label className="comp-label" style={{ marginTop: 16 }}>Charts ({charts.length})</label>
      {charts.length === 0 ? (
        <div className="chat-empty">No charts yet — click a metric above.</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {charts.map((c, i) => (
            <div key={`${c.metric}-${i}`} className="golden" style={{ gap: 10 }}>
              <input type="text" value={c.name} onChange={(e) => updateChart(i, { name: e.target.value })} style={{ maxWidth: 200 }} />
              <select value={c.vizType} onChange={(e) => updateChart(i, { vizType: e.target.value as VizType })}>
                {VIZ_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <span className="mono muted" style={{ fontSize: 12 }}>{c.metric}</span>
              <button className="chip-x" style={{ marginLeft: 'auto' }} onClick={() => removeChart(i)} aria-label="Remove chart">×</button>
            </div>
          ))}
        </div>
      )}

      {multiView ? (
        <div className="hint" style={{ marginTop: 12, color: 'var(--warn-text, inherit)' }}>
          These charts span more than one Cube view (<strong>{views.join(', ')}</strong>). A dashboard binds to a single view — keep charts from one view.
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Build ─────────────────────────── */

function BuildStage({
  name, building, error, result, canBuild, onBuild, onContinue,
}: {
  name: string;
  building: boolean;
  error: string;
  result: BuildResponse | null;
  canBuild: boolean;
  onBuild: () => void;
  onContinue: () => void;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="hint" style={{ marginTop: 0 }}>
          Apply the spec and verify every adapter — Superset, embed, reports and alerts. The report renders inline below.
        </span>
        <button className="btn" onClick={onBuild} disabled={building || !canBuild}>
          {building ? <span className="spin" /> : result ? 'Rebuild' : 'Build dashboard'}
        </button>
      </div>
      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="build-report" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{result.build.ok ? 'Build succeeded' : 'Build had errors'} — {result.spec.name || name}</strong>
            <span className={`badge ${result.build.mode === 'live' ? 'ok' : 'muted'}`}>{result.build.mode}</span>
          </div>
          {result.build.rows.map((r) => (
            <div key={r.tool} className={`build-row ${r.status === 'ok' ? 'ok' : 'fail'}`}>
              <span className="build-tool">{r.status === 'ok' ? '✓' : '✗'} {r.tool}</span>
              <span>{r.detail || r.error}</span>
            </div>
          ))}
          {result.build.ok ? (
            <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={onContinue}>View it →</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
