/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
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
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import type { ViewMode } from '@/lib/core/view-mode';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import DashboardGrid from './DashboardGrid';
import PanelBuilder from './PanelBuilder';
import ConnectTools from './ConnectTools';
import Reports from './Reports';
import StageAssistant from './StageAssistant';

const DASH_MODE_KEY = 'dashboards.viewMode';
import {
  flatMetrics, panelMetrics, postJson, slug, VIZ_TYPES,
  type BuildResponse, type ChartSpec, type DashboardDetail, type DashboardSummary, type DashTier,
  type MetricGroups, type MetricSummary, type Panel, type VizType,
  TIER_BADGE, TIER_LABEL,
} from './shared';

/** The Cube view a chart's member belongs to (member = `View.measure`). */
const viewOfMetric = (m: string) => (m.includes('.') ? m.slice(0, m.indexOf('.')) : m);

/** Map a (possibly legacy) viz string from the assistant to a current VizType. */
const normalizeViz = (v: string): VizType => (v === 'big_number_total' ? 'big_number' : (v as VizType));

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
 * dashboard starts on Define and walks forward as its real state settles (panels → save →
 * viewed → persisted); an EXISTING dashboard is already saved + persisted, so it opens at
 * View. View renders NATIVELY (DashboardGrid — Apache ECharts on the governed Cube layer,
 * per-viewer RLS); Design uses the PanelBuilder; Govern folds in Reports, promotion and
 * the Tier-2 ConnectTools (Power BI / Tableau / Superset console).
 */
export default function DashboardBuilder({
  existing,
  initialDatasetId,
  metrics,
  metricsLoading,
  onBack,
  onChanged,
}: {
  /** Open an already-built dashboard (lands at View), or null to create a new one (Define). */
  existing: DashboardSummary | null;
  /** When creating, pre-filter the metric palette to this dataset's metrics (Data tab
   *  → "＋ New dashboard" deep-link). A dashboard binds to one Cube view, so scoping the
   *  palette to one dataset keeps every chart on that dataset's view. */
  initialDatasetId?: string;
  metrics: MetricGroups | null;
  metricsLoading: boolean;
  onBack: () => void;
  /** Refresh the list after a build/archive/restore/version; delete returns to the list. */
  onChanged: () => void;
}) {
  const { user } = useUser();
  const palette = useMemo(() => {
    const flat = flatMetrics(metrics);
    return !existing && initialDatasetId ? flat.filter((m) => m.datasetId === initialDatasetId) : flat;
  }, [metrics, existing, initialDatasetId]);

  // Simple ⇄ Developer view mode (persisted per user, defaults to Simple).
  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(DASH_MODE_KEY);
    if (saved === 'simple' || saved === 'developer') setViewMode(saved as ViewMode);
  }, []);
  const setModePersisted = (m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(DASH_MODE_KEY, m);
  };

  // Draft-in-progress state (new dashboards). An existing dashboard seeds name/view but
  // has no client-side chart specs (the list returns a count only) — it's already built.
  const [name, setName] = useState(existing?.name ?? '');
  const [charts, setCharts] = useState<ChartSpec[]>([]);
  const [build, setBuild] = useState<BuildResponse | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildErr, setBuildErr] = useState('');
  // Honest Design-assistant outcome (Northpeak fix): if a suggested chart had to be dropped
  // (unknown member), SAY so — never a silent filter that quietly shrinks the chart list.
  const [designNote, setDesignNote] = useState('');
  const [viewed, setViewed] = useState(false);
  const [liveRls, setLiveRls] = useState('');
  // An existing dashboard's panels are fetched (the list returns only a count); a fresh one
  // uses the in-progress `charts`. These panels feed the native ECharts grid in View.
  const [fetchedPanels, setFetchedPanels] = useState<Panel[] | null>(null);
  useEffect(() => {
    if (!existing) { setFetchedPanels(null); return; }
    let alive = true;
    fetch(`/api/dashboards/${existing.id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DashboardDetail | null) => { if (alive && d) setFetchedPanels(d.panels ?? []); })
      .catch(() => { if (alive) setFetchedPanels([]); });
    return () => { alive = false; };
  }, [existing]);
  const gridPanels: Panel[] = existing
    ? (fetchedPanels ?? [])
    : charts.map((c) => ({ ...c, metrics: c.metrics && c.metrics.length ? c.metrics : (c.metric ? [c.metric] : []) }));

  // The persisted dashboard we govern/view: the freshly-saved one, or the one we opened.
  const built: DashboardSummary | null = useMemo(() => {
    if (existing) return existing;
    if (build) {
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
    () => Array.from(new Set(charts.flatMap((c) => panelMetrics(c).map(viewOfMetric)).filter(Boolean))),
    [charts],
  );
  const view = existing?.view ?? views[0] ?? '';
  const multiView = views.length > 1;

  // The live ctx the stage gates/✓ read — real dashboard state, never faked.
  const ctx: DashCtx = {
    defined: !!existing || (!!name.trim() && charts.length > 0 && !!view),
    hasCharts: !!existing || (charts.length > 0 && !multiView),
    builtOk: !!existing || !!build,
    viewed: !!existing || viewed,
    persisted: !!built,
  };

  // Open on the first REACHABLE stage: a new dashboard on Define, an existing one on View.
  const [stage, setStage] = useState<StageState<DashStageId>>(() => {
    const base = initialStageState(DASH_STAGES);
    return existing ? { ...base, current: 'view' } : base;
  });

  const addChart = (m: MetricSummary) =>
    setCharts((cs) => [...cs, { name: m.name, vizType: 'big_number', metrics: [m.member] }]);
  const addPanel = (p: Panel) => setCharts((cs) => [...cs, p]);
  const removeChart = (i: number) => setCharts((cs) => cs.filter((_, j) => j !== i));

  const runBuild = async () => {
    setBuildErr('');
    setBuild(null);
    const trimmed = name.trim();
    if (!trimmed) return setBuildErr('Give the dashboard a name.');
    if (charts.length === 0) return setBuildErr('Add at least one panel on a governed metric.');
    if (multiView) return setBuildErr(`A dashboard binds to one Cube view — these panels span ${views.join(', ')}. Keep panels from a single view.`);
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
      // Saved → record the stage ✓ and walk forward to view it natively.
      setStage((s) => markDone(s, 'build'));
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
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>← All dashboards</button>
        <BuilderModeToggle
          mode={viewMode}
          onChange={setModePersisted}
          developerHint="The native panel spec and the resolved row-level-security clause"
        />
      </div>

      {built ? (
        <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{built.name}</h2>
          {(built.tier === 'domain' || built.tier === 'marketplace') ? <DomainTag domain={built.domain} /> : null}
          <span className={`badge ${TIER_BADGE[built.tier]}`}>{TIER_LABEL[built.tier]}</span>
          <span className="muted mono" style={{ fontSize: 12 }}>{built.view}</span>
          {/* Lifecycle (Archive/Restore/Delete) lives in the persistent detail header so it is
              reachable from ANY stage — not buried in Govern. Governance unchanged (canManage).
              PromoteButton stays in the Govern stage (stage-specific action). */}
          {canManage ? (
            <div style={{ marginLeft: 'auto' }}>
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
          ) : null}
        </div>
      ) : null}

      {viewMode === 'developer' ? (
        <DashboardDeveloperView built={built} build={build} charts={charts} name={name} view={view} liveRls={liveRls} />
      ) : (
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
              onCharts={(cs) => {
                // NEVER a silent discard (Northpeak fix): keep every chart whose measure is
                // governed, PRESERVE its group-by dimensions (the spec survives — a missing
                // dimension is flagged at render, not stripped here), and REPORT any chart
                // that had to be rejected for an unknown measure.
                const ok = cs.filter((c) => VIZ_TYPES.includes(normalizeViz(c.vizType)) && palette.some((m) => m.member === c.metric));
                const dropped = cs.filter((c) => !ok.includes(c));
                setCharts(ok.map((c) => ({
                  name: c.name,
                  vizType: normalizeViz(c.vizType),
                  metrics: [c.metric],
                  ...(Array.isArray(c.dimensions) && c.dimensions.length
                    ? { dimensions: c.dimensions.filter((d): d is string => typeof d === 'string').slice(0, 1) }
                    : {}),
                })));
                setDesignNote(dropped.length
                  ? `${dropped.length} suggested chart${dropped.length === 1 ? ' was' : 's were'} rejected — unknown or ungoverned member${dropped.length === 1 ? '' : 's'}: ${dropped.map((c) => c.metric || c.name).join(', ')}.`
                  : '');
              }}
            />
          ) : st.id === 'build' ? (
            <StageAssistant
              stage="build" label="Explain a save error in plain language." cta="Explain the error"
              disabled={!buildErr}
              payload={() => ({ reason: buildErr })}
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
          <>
            {designNote ? <div className="error" role="alert" style={{ marginBottom: 10 }}>⚠ {designNote}</div> : null}
            <DesignStage
              view={view} palette={palette}
              charts={charts} addPanel={addPanel} removeChart={removeChart}
              multiView={multiView} views={views}
            />
          </>
        ) : null}

        {stage.current === 'build' ? (
          <BuildStage
            name={name} building={building} error={buildErr} result={build}
            canBuild={!!name.trim() && charts.length > 0 && !multiView}
            onBuild={runBuild} onContinue={() => go('view')}
          />
        ) : null}

        {stage.current === 'view' && built ? (
          <div {...anchorAttr(ANCHORS.dashboards.view)}>
            <DashboardGrid
              view={built.view}
              panels={gridPanels}
              onLoaded={({ rls }) => { setLiveRls(rls); setViewed(true); setStage((s) => markDone(s, 'view')); }}
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
          <div {...anchorAttr(ANCHORS.dashboards.govern)}>
            <div className="section-title">Reports</div>
            <Reports dashboard={built} />
            {canManage ? (
              <>
                <div className="section-title">Lifecycle</div>
                {/* Archive / Restore / Delete now live in the persistent detail header (reachable
                    from any stage). Only Promote remains here as a stage-specific action. */}
                <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <PromoteButton
                    id={built.id}
                    kind="dashboard"
                    tier={ladderTier(built.tier)}
                    promoteUrl={`/api/dashboards/${built.id}/promote`}
                    canApprove={canApprove}
                    onDone={onChanged}
                  />
                </div>
              </>
            ) : (
              <p className="hint">You can report on this dashboard. Promotion and archiving are limited to its owner and domain admins.</p>
            )}
            <div className="section-title">Connected tools</div>
            <ConnectTools />
          </div>
        ) : stage.current === 'govern' ? (
          <div className="chat-empty">Build the dashboard first — there is nothing to govern yet.</div>
        ) : null}
      </StageShell>
      )}
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
    <div className="agent-editor" style={{ marginTop: 4 }} {...anchorAttr(ANCHORS.dashboards.define)}>
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
  view, palette, charts, addPanel, removeChart, multiView, views,
}: {
  view: string;
  palette: MetricSummary[];
  charts: ChartSpec[];
  addPanel: (p: Panel) => void;
  removeChart: (i: number) => void;
  multiView: boolean;
  views: string[];
}) {
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 4 }} {...anchorAttr(ANCHORS.dashboards.design)}>
      <PanelBuilder view={view} palette={palette} onAdd={addPanel} />

      <div>
        <label className="comp-label">Panels ({charts.length})</label>
        {charts.length === 0 ? (
          <div className="chat-empty">No panels yet — design one above and “Add panel”.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
            {charts.map((c, i) => (
              <div key={`${c.name}-${i}`} className="golden" style={{ gap: 10, alignItems: 'center' }}>
                <span className="panel-card-title">{c.name}</span>
                <span className={`badge ${c.vizType === 'table' ? 'muted' : 'ok'}`}>{c.vizType}</span>
                <span className="mono muted" style={{ fontSize: 12 }}>{panelMetrics(c).join(', ')}</span>
                <button className="chip-x" style={{ marginLeft: 'auto' }} onClick={() => removeChart(i)} aria-label="Remove panel">×</button>
              </div>
            ))}
          </div>
        )}
        {charts.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <label className="comp-label">Preview</label>
            <DashboardGrid view={view} panels={charts.map((c) => ({ ...c, metrics: panelMetrics(c) }))} />
          </div>
        ) : null}
      </div>

      {multiView ? (
        <div className="hint" style={{ color: 'var(--warn-text, inherit)' }}>
          These panels span more than one Cube view (<strong>{views.join(', ')}</strong>). A dashboard binds to a single view — keep panels from one view.
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Build (save) ─────────────────────────── */

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
    <div style={{ marginTop: 4 }} {...anchorAttr(ANCHORS.dashboards.build)}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="hint" style={{ marginTop: 0 }}>
          Save the dashboard. It renders natively at View time — Apache ECharts on your governed
          metrics, row-level-security scoped to each viewer. No BI-tool import step.
        </span>
        <button className="btn" onClick={onBuild} disabled={building || !canBuild}>
          {building ? <span className="spin" /> : result ? 'Re-save' : 'Save dashboard'}
        </button>
      </div>
      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="build-report" style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Saved — {result.spec.name || name}</strong>
            <span className="badge ok">{result.spec.charts.length} panel{result.spec.charts.length === 1 ? '' : 's'} on {result.spec.view}</span>
          </div>
          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onContinue}>View it →</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Developer surface ─────────────────────────── */

/**
 * The Dashboards Developer view — shows the raw Superset dashboard spec (chart JSON
 * + view binding) and the live embed config (guest token request + RLS clauses). Both
 * surfaces are real data the builder already holds — nothing fabricated. If the
 * dashboard hasn't been built yet, the in-progress chart spec is shown. Read-only.
 */
function DashboardDeveloperView({
  built,
  build,
  charts,
  name,
  view,
  liveRls,
}: {
  built: DashboardSummary | null;
  build: BuildResponse | null;
  charts: ChartSpec[];
  name: string;
  view: string;
  liveRls: string;
}) {
  const spec = build
    ? build.spec
    : charts.length > 0
      ? { name: name || '(unnamed)', view: view || '(no view bound)', charts }
      : null;

  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 4 }}>
      <div className="grant-block">
        <div className="comp-label">Dashboard spec (JSON)</div>
        <p className="hint" style={{ marginTop: 4 }}>
          Read-only — the native panel/view config persisted for this dashboard. Each panel
          resolves its governed Cube query at View time (Apache ECharts), so there is no
          Superset import step. Add panels in the Simple flow to see the full spec.
        </p>
        {spec ? (
          <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            {JSON.stringify(spec, null, 2)}
          </pre>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            No spec yet — add panels in the Simple flow to see the config here.
          </p>
        )}
      </div>

      <div className="grant-block">
        <div className="comp-label">Row-level security (resolved as the viewer)</div>
        <p className="hint" style={{ marginTop: 4 }}>
          Each panel-query runs under the viewer’s delegated identity; Cube applies this
          clause as RLS so two viewers see different rows. Open the View stage to resolve it.
        </p>
        {built ? (
          <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            {JSON.stringify(
              {
                dashboardId: built.id,
                view: built.view,
                tier: built.tier,
                liveRls: liveRls || '(not yet viewed — open View stage to resolve it)',
              },
              null,
              2,
            )}
          </pre>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            Save and view the dashboard in the Simple flow to see the row-level security here.
          </p>
        )}
      </div>
    </div>
  );
}
