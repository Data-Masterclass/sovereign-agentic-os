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
import DemoteButton from '@/components/lifecycle/DemoteButton';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import BusyProgress from '@/components/core/BusyProgress';
import type { ViewMode } from '@/lib/core/view-mode';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import DashboardGrid from './DashboardGrid';
import PanelBuilder from './PanelBuilder';
import Reports from './Reports';

const DASH_MODE_KEY = 'dashboards.viewMode';
import {
  flatMetrics, panelMetrics, postJson, slug,
  type BuildResponse, type ChartSpec, type DashboardDetail, type DashboardSummary, type DashTier,
  type MetricGroups, type MetricSummary, type Panel, type PanelFilter,
  TIER_BADGE, TIER_LABEL,
} from './shared';

const leaf = (member: string) => (member.includes('.') ? member.slice(member.lastIndexOf('.') + 1) : member);

/** The Cube view a chart's member belongs to (member = `View.measure`). */
const viewOfMetric = (m: string) => (m.includes('.') ? m.slice(0, m.indexOf('.')) : m);

/** Dashboard tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: DashTier): Visibility =>
  tier === 'domain' ? 'shared' : tier === 'marketplace' ? 'certified' : 'personal';
/** Dashboard tier → the shared ladder tier the PromoteButton speaks. */
const ladderTier = (tier: DashTier): PromoteTier =>
  tier === 'domain' ? 'Shared' : tier === 'marketplace' ? 'Marketplace' : 'Personal';

/**
 * The Dashboards builder — a plain View/Edit surface (no staged flow). A NEW dashboard opens
 * in EDIT (name + panel builder + Save). An EXISTING dashboard opens in VIEW: the native
 * ECharts grid (Apache ECharts on the governed-SQL metrics path, per-viewer RLS from OPA
 * identity) with a "✎ Edit" button that switches to Edit; Save returns to View. Save is an
 * UPSERT under the existing id — an existing dashboard (or one already saved this session)
 * rebuilds under its OWN id, so editing updates rather than duplicates (commit 61a618c).
 * Promotion + lifecycle live in the detail HEADER; Reports and the BI ConnectTools fold in
 * calmly below the grid in View.
 */
export default function DashboardBuilder({
  existing,
  initialDatasetId,
  initialMetric,
  metrics,
  metricsLoading,
  onBack,
  onChanged,
}: {
  /** Open an already-built dashboard (lands at View), or null to create a new one (Edit). */
  existing: DashboardSummary | null;
  /** When creating, pre-filter the metric palette to this dataset's metrics (Data tab
   *  → "＋ New dashboard" deep-link). A dashboard binds to one Cube view, so scoping the
   *  palette to one dataset keeps every chart on that dataset's view. */
  initialDatasetId?: string;
  /** When creating, pre-select this metric MEMBER in the panel builder (Metric View →
   *  "Add to a dashboard" — the Power BI pin-visual flow). Nil-safe. */
  initialMetric?: string;
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

  // Member → metric id (RLS-scoped registry) — resolves each panel's "what is this
  // number?" backlink to the metric's View. Undefined while metrics load = plain text.
  const metricIdOf = useMemo(() => {
    const byMember = new Map(flatMetrics(metrics).map((m) => [m.member, m.id]));
    return (member: string) => byMember.get(member);
  }, [metrics]);

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

  // Mode: a NEW dashboard opens in Edit; an EXISTING one opens in View.
  const [mode, setMode] = useState<'view' | 'edit'>(existing ? 'view' : 'edit');

  // Draft-in-progress state. An existing dashboard seeds name/view but has no client-side
  // chart specs at first (the list returns a count only) — its panels are fetched below.
  const [name, setName] = useState(existing?.name ?? '');
  const [charts, setCharts] = useState<ChartSpec[]>([]);
  const [build, setBuild] = useState<BuildResponse | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildErr, setBuildErr] = useState('');
  const [liveRls, setLiveRls] = useState('');
  // Which panel is being edited (index into `charts`) + a bump key so re-selecting the same
  // panel re-seeds the builder. null = adding a new panel.
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editKey, setEditKey] = useState(0);
  // Inline rename (display name only — the Cube view is frozen). `nameOverride` lets the
  // header reflect the new name immediately without a full re-open of the builder.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameErr, setRenameErr] = useState('');
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  // An existing dashboard's panels are fetched (the list returns only a count); a fresh one
  // uses the in-progress `charts`. These panels feed the native ECharts grid in View.
  const [fetchedPanels, setFetchedPanels] = useState<Panel[] | null>(null);
  // The persisted default filters (P1-3) — seed the View grid's chips on open; a fresh
  // dashboard has none. `activeFilters` tracks the chips the grid currently has active
  // (surfaced up via onFiltersChange) so Save can persist them as the new defaults.
  const [savedFilters, setSavedFilters] = useState<PanelFilter[]>([]);
  const [activeFilters, setActiveFilters] = useState<PanelFilter[]>([]);
  useEffect(() => {
    if (!existing) { setFetchedPanels(null); setSavedFilters([]); setActiveFilters([]); return; }
    let alive = true;
    fetch(`/api/dashboards/${existing.id}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DashboardDetail | null) => {
        if (!alive || !d) return;
        const panels = d.panels ?? [];
        setFetchedPanels(panels);
        const filters = d.filters ?? [];
        setSavedFilters(filters);
        setActiveFilters(filters);
        // Seed the EDITABLE draft too (once, never clobbering in-progress edits): opening
        // Edit on an existing dashboard must show its real panels (61a618c rehydration).
        setCharts((cs) => (cs.length === 0 ? panels : cs));
      })
      .catch(() => { if (alive) setFetchedPanels([]); });
    return () => { alive = false; };
  }, [existing]);
  // The View grid renders the DRAFT once it exists (so an edited-and-rebuilt existing
  // dashboard shows its new panels immediately), else the fetched persisted panels.
  const gridPanels: Panel[] = charts.length > 0 || !existing
    ? charts.map((c) => ({ ...c, metrics: c.metrics && c.metrics.length ? c.metrics : (c.metric ? [c.metric] : []) }))
    : (fetchedPanels ?? []);

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
        folder: '/',
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

  const addPanel = (p: Panel) =>
    setCharts((cs) => {
      // Editing replaces the panel in place; a fresh add appends.
      if (editIdx !== null) return cs.map((c, i) => (i === editIdx ? p : c));
      return [...cs, p];
    });
  const removeChart = (i: number) =>
    setCharts((cs) => cs.filter((_, j) => j !== i));
  const editChart = (i: number) => { setEditIdx(i); setEditKey((k) => k + 1); };
  const cancelEdit = () => setEditIdx(null);

  const runBuild = async () => {
    setBuildErr('');
    const trimmed = name.trim();
    if (!trimmed) return setBuildErr('Give the dashboard a name.');
    if (charts.length === 0) return setBuildErr('Add at least one panel on a governed metric.');
    if (multiView) return setBuildErr(`A dashboard binds to one Cube view — these panels span ${views.join(', ')}. Keep panels from a single view.`);
    setBuilding(true);
    try {
      // EDITING keeps the identity: an existing dashboard (or one already saved this
      // session) rebuilds under its OWN id — the store upserts + version-snapshots.
      // Only a genuinely new dashboard mints an id (61a618c).
      const res = await postJson<BuildResponse>('/api/dashboards/build', {
        id: existing?.id ?? build?.id ?? `${slug(trimmed) || 'dashboard'}-${Math.random().toString(36).slice(2, 8)}`,
        name: trimmed,
        view,
        mode: 'drag-drop',
        charts,
        // Persist the currently-active chips as the dashboard's DEFAULT filters (P1-3) —
        // View re-opens narrowed to these. Absent/empty = no defaults (unchanged behaviour).
        ...(activeFilters.length ? { filters: activeFilters } : {}),
      });
      setBuild(res);
      // The just-saved chips become the persisted defaults (so a subsequent View seeds them).
      setSavedFilters(activeFilters);
      onChanged();
      // Saved → return to the native View.
      setMode('view');
    } catch (e) {
      setBuildErr((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  const canManage = !!user && !!built && canManageArtifact(user, { owner: built.owner, domain: built.domain ?? '' });
  const canApprove = !!user && roleAtLeast(user.role, 'builder');

  // The name shown in the header — the local override (post-rename) wins over the record.
  const displayName = nameOverride ?? built?.name ?? '';

  // Rename the dashboard (display name only). The store freezes the Cube view before the
  // name changes, so every panel binding stays pinned to the real view.
  const rename = async () => {
    if (!built) return;
    const nn = nameDraft.trim();
    setRenameErr('');
    if (!nn) { setRenaming(false); return; }
    const res = await fetch(`/api/dashboards/${built.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', name: nn }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRenameErr(d.error ?? 'Rename failed'); return; }
    setNameOverride(nn);
    setName(nn);
    setRenaming(false);
    onChanged();
  };

  const canBuild = !!name.trim() && charts.length > 0 && !multiView;

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
          {renaming ? (
            <span className="rename-inline">
              <input
                className="rename-input"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(false); }}
                onBlur={() => void rename()}
                aria-label="Dashboard name"
              />
              <button className="btn primary sm" onClick={() => void rename()}>Save</button>
              <button className="btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button>
            </span>
          ) : (
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              {displayName}
              {/* Rename must be DISCOVERABLE — a labelled button, not a bare glyph (mirrors Data). */}
              {canManage ? (
                <button
                  className="btn ghost sm"
                  style={{ flex: 'none' }}
                  onClick={() => { setNameDraft(displayName); setRenameErr(''); setRenaming(true); }}
                  title="Rename this dashboard (the Cube view binding stays stable)"
                  aria-label="Rename this dashboard"
                >✎ Rename</button>
              ) : null}
            </h2>
          )}
          {(built.tier === 'domain' || built.tier === 'marketplace') ? <DomainTag domain={built.domain} /> : null}
          <span className={`badge ${TIER_BADGE[built.tier]}`}>{TIER_LABEL[built.tier]}</span>
          <span className="muted mono" style={{ fontSize: 12 }}>{built.view}</span>
          {/* Lifecycle + Promote live in the persistent detail header — reachable from View or
              Edit (there is no Govern stage). Governance unchanged (canManage / canApprove). */}
          {canManage ? (
            <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center' }}>
              <PromoteButton
                id={built.id}
                kind="dashboard"
                tier={ladderTier(built.tier)}
                promoteUrl={`/api/dashboards/${built.id}/promote`}
                canApprove={canApprove}
                onDone={onChanged}
              />
              <DemoteButton
                kind="dashboard"
                tier={built.tier === 'marketplace' ? 'Marketplace' : built.tier === 'domain' ? 'Shared' : 'Personal'}
                demoteUrl={`/api/dashboards/${built.id}/demote`}
                onDone={onChanged}
              />
              <LifecycleActions
                id={built.id}
                name={displayName}
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
      {renameErr ? <div className="error" style={{ marginBottom: 8 }}>{renameErr}</div> : null}

      {/* View ⇄ Edit toggle: an existing dashboard shows "✎ Edit"; Edit shows "View" once it
          has been saved (a fresh, never-saved dashboard has nothing to view yet). */}
      {built ? (
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button
            className={`btn ${mode === 'view' ? 'primary' : 'ghost'} sm`}
            onClick={() => setMode('view')}
          >View</button>
          {canManage ? (
            <button
              className={`btn ${mode === 'edit' ? 'primary' : 'ghost'} sm`}
              onClick={() => setMode('edit')}
            >✎ Edit</button>
          ) : null}
        </div>
      ) : null}

      {viewMode === 'developer' ? (
        <DashboardDeveloperView built={built} build={build} charts={charts} name={name} view={view} liveRls={liveRls} />
      ) : mode === 'edit' ? (
        <EditPane
          name={name} setName={setName} view={view}
          palette={palette} loading={metricsLoading}
          charts={charts} addPanel={addPanel} removeChart={removeChart}
          editIdx={editIdx} editKey={editKey} editChart={editChart} cancelEdit={cancelEdit}
          multiView={multiView} views={views}
          building={building} buildErr={buildErr} canBuild={canBuild}
          onBuild={runBuild} saved={!!built}
          initialMetric={initialMetric}
          metricIdOf={metricIdOf}
          defaultFilters={activeFilters}
        />
      ) : built ? (
        <div {...anchorAttr(ANCHORS.dashboards.view)}>
          <DashboardGrid
            view={built.view}
            panels={gridPanels}
            onLoaded={({ rls }) => setLiveRls(rls)}
            metricIdOf={metricIdOf}
            // Seed the chips from the persisted defaults (P1-3); surface live chips up so a
            // subsequent Save (from Edit) persists whatever the viewer narrowed to.
            initialFilters={savedFilters}
            onFiltersChange={setActiveFilters}
          />
          <div {...anchorAttr(ANCHORS.dashboards.govern)} style={{ marginTop: 24 }}>
            <div className="section-title">Reports</div>
            <Reports dashboard={built} />
            {/* Connected tools (Power BI / Tableau / Superset) is REMOVED from View for now —
                the connections are unverified; restore <ConnectTools /> once each is proven live. */}
          </div>
        </div>
      ) : (
        <div className="chat-empty">Save the dashboard first — there is nothing to view yet.</div>
      )}
    </ConfirmProvider>
  );
}

/* ─────────────────────────── Edit ─────────────────────────── */

function EditPane({
  name, setName, view, palette, loading,
  charts, addPanel, removeChart, editIdx, editKey, editChart, cancelEdit,
  multiView, views, building, buildErr, canBuild, onBuild, saved,
  initialMetric, metricIdOf, defaultFilters,
}: {
  name: string;
  setName: (v: string) => void;
  view: string;
  palette: MetricSummary[];
  loading: boolean;
  charts: ChartSpec[];
  addPanel: (p: Panel) => void;
  removeChart: (i: number) => void;
  editIdx: number | null;
  editKey: number;
  editChart: (i: number) => void;
  cancelEdit: () => void;
  multiView: boolean;
  views: string[];
  building: boolean;
  buildErr: string;
  canBuild: boolean;
  onBuild: () => void;
  saved: boolean;
  initialMetric?: string;
  metricIdOf?: (member: string) => string | undefined;
  /** The chips that will be saved as the dashboard's default filters (P1-3). */
  defaultFilters: PanelFilter[];
}) {
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 4 }} {...anchorAttr(ANCHORS.dashboards.design)}>
      <div className="agent-editor" style={{ marginTop: 0 }} {...anchorAttr(ANCHORS.dashboards.define)}>
        <label className="comp-label">Dashboard name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales overview" />
        <div className="hint" style={{ marginTop: 6 }}>
          Cube view: <code>{view || '—'}</code> · a dashboard binds to ONE governed view; add panels to bind it.
        </div>
      </div>

      <PanelBuilder
        view={view}
        palette={palette}
        onAdd={addPanel}
        editing={editIdx !== null ? charts[editIdx] : null}
        editKey={editKey}
        onCancelEdit={cancelEdit}
        initialMetrics={initialMetric ? [initialMetric] : undefined}
      />
      {loading && palette.length === 0 ? <div className="hint">Loading metrics…</div> : null}
      {!loading && palette.length === 0 ? (
        <div className="hint">No governed metrics yet — define one in the Metrics tab.</div>
      ) : null}

      <div>
        <label className="comp-label">Panels ({charts.length})</label>
        {charts.length === 0 ? (
          <div className="chat-empty">No panels yet — design one above and “Add panel”.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
            {charts.map((c, i) => (
              <div
                key={`${c.name}-${i}`}
                className="golden"
                style={{ gap: 10, alignItems: 'center', ...(editIdx === i ? { outline: '2px solid var(--gold, #c8a24a)' } : {}) }}
              >
                <span className="panel-card-title">{c.name}</span>
                <span className={`badge ${c.vizType === 'table' ? 'muted' : 'ok'}`}>{c.vizType}</span>
                <span className="mono muted" style={{ fontSize: 12 }}>{panelMetrics(c).join(', ')}</span>
                <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => editChart(i)} aria-label="Edit panel">Edit</button>
                  <button className="chip-x" onClick={() => removeChart(i)} aria-label="Remove panel">×</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {charts.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <label className="comp-label">Preview</label>
            <DashboardGrid view={view} panels={charts.map((c) => ({ ...c, metrics: panelMetrics(c) }))} metricIdOf={metricIdOf} />
          </div>
        ) : null}
      </div>

      {multiView ? (
        <div className="hint" style={{ color: 'var(--warn-text, inherit)' }}>
          These panels span more than one Cube view (<strong>{views.join(', ')}</strong>). A dashboard binds to a single view — keep panels from one view.
        </div>
      ) : null}

      {/* Default filters (P1-3): the chips active in View are saved WITH the dashboard, so
          it opens narrowed to them for every viewer. Calm, informational — set them by
          clicking in View, not here. */}
      {defaultFilters.length > 0 ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="hint" style={{ margin: 0 }}>Default filters:</span>
          {defaultFilters.map((f) => (
            <span key={f.member} className="chip ok">{leaf(f.member)} = {f.values.join(', ')}</span>
          ))}
          <span className="hint" style={{ margin: 0 }}>(saved with the dashboard)</span>
        </div>
      ) : null}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }} {...anchorAttr(ANCHORS.dashboards.build)}>
        <span className="hint" style={{ marginTop: 0 }}>
          Save the dashboard. It renders natively — Apache ECharts on your governed metrics,
          row-level-security scoped to each viewer. No BI-tool import step.
        </span>
        <button className="btn primary" onClick={onBuild} disabled={building || !canBuild}>
          {building ? <span className="spin" /> : saved ? 'Save changes' : 'Save dashboard'}
        </button>
      </div>
      {building ? (
        <BusyProgress
          label={saved ? 'Saving changes' : 'Saving dashboard'}
          detail="Persisting the panel spec and registering the dashboard under its governed view"
        />
      ) : null}
      {buildErr ? <div className="error">{buildErr}</div> : null}
    </div>
  );
}

/* ─────────────────────────── Developer surface ─────────────────────────── */

/**
 * The Dashboards Developer view — shows the native panel spec (chart JSON + view binding)
 * and the resolved RLS clause. Both surfaces are real data the builder already holds —
 * nothing fabricated. If the dashboard hasn't been saved yet, the in-progress chart spec is
 * shown. Read-only.
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
          resolves its governed query at View time (Apache ECharts), so there is no
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
          Each panel-query runs under the viewer’s delegated identity; per-viewer RLS comes
          from OPA identity so two viewers see different rows. Open View to resolve it.
        </p>
        {built ? (
          <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            {JSON.stringify(
              {
                dashboardId: built.id,
                view: built.view,
                tier: built.tier,
                liveRls: liveRls || '(not yet viewed — open View to resolve it)',
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
