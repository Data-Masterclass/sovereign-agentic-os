/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import LineagePanel from './LineagePanel';
import RefinePanel from './RefinePanel';
import GoldJoinPanel from './GoldJoinPanel';
import ExplorePanel from './ExplorePanel';
import BronzePanel from './BronzePanel';
import SyncPanel from './SyncPanel';
import QualityFixPanel from './QualityFixPanel';
import AiAction, { type CleanDraft, type DefineDraft } from './StageAssistant';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import DomainTag from '@/components/DomainTag';
import type { Visibility } from '@/lib/core/lifecycle';
import StageShell from '@/components/core/StageShell';
import { usePublishPageContext } from '@/components/core/PageContext';
import { initialStageState, markDone, advance, type StageState } from '@/lib/core/stages';
import { DATA_STAGES, type DataStageId, type DataCtx } from '@/lib/data/stages';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import type { ViewMode } from '@/lib/core/view-mode';
import { TIER_BADGE_CLASS } from '@/lib/core/scopes';
import type { GoldSpec } from '@/lib/data/dataset-schema';

const DATA_MODE_KEY = 'data.viewMode';

type Layer = 'bronze' | 'silver' | 'gold';
type VersionState = { built: boolean; updatedAt: string | null; artifact: string | null };
type ColumnDoc = { name: string; description: string };
type DataCheckRule = 'not_null' | 'not_blank' | 'unique' | 'accepted_values' | 'range';
type DataCheck = {
  id: string; name: string; description: string; createdBy: string; createdAt: string;
  rule?: DataCheckRule; column?: string; values?: string[]; min?: number; max?: number;
};
type CheckStatus = 'pass' | 'fail' | 'not_run';
type CheckResult = { id: string; label: string; status: CheckStatus; violations: number | null; reason?: string };
type QualityBadge = 'passing' | 'failing' | 'unknown';
/** Health score payload — mirrors HealthScore from lib/data/dq. */
type HealthScore = { score: number | null; status: QualityBadge; passing: number; failing: number; notRun: number };
/** One persisted run's health point — mirrors healthTrend from lib/data/dq-results. */
type TrendPoint = { ranAt: string; score: number | null; badge: QualityBadge };
/** A deterministic profile→rule proposal — mirrors SuggestedCheck from lib/data/dq-suggest. */
type SuggestedCheck = { rule: DataCheckRule; column: string; values?: string[]; min?: number; max?: number; evidence: string };
/** A heuristic-monitor toggle — mirrors MonitorKind from lib/data/dq-monitors. */
type MonitorKind = 'freshness' | 'volume' | 'schema';
type MonitorToggle = { kind: MonitorKind; enabled: boolean };
const MONITOR_LABELS: Record<MonitorKind, { label: string; hint: string }> = {
  freshness: { label: 'Freshness', hint: 'Data arrives on its expected cadence' },
  volume: { label: 'Row volume', hint: 'Row count stays within its normal band' },
  schema: { label: 'Schema stable', hint: 'Columns are not added, dropped or retyped' },
};
type Certification = { level: string; by: string; at: string };
/** Promotion gate + in-flight request — mirrors the promote route's GET payload. */
type Gate = { ok: boolean; missing: string[] };
type PromoteStatus = { tier: Dataset['tier']; gate: Gate; request: { status: string; detail?: string } | null };
/** Governed row-preview outcome — mirrors PreviewOutcome from lib/data/preview. */
type RowPreview =
  | { available: true; layer: string; fqn: string; limit: number; columns: string[]; rows: string[][]; rowCount: number }
  | { available: false; layer?: string; fqn?: string; reason: string };

const RULE_LABELS: Record<DataCheckRule, string> = {
  not_null: 'Not null',
  not_blank: 'Not blank',
  unique: 'Unique',
  accepted_values: 'Accepted values',
  range: 'In range',
};
const RULE_KINDS = new Set<DataCheckRule>(['not_null', 'not_blank', 'unique', 'accepted_values', 'range']);

/** A human, exception-first label for a suggested check (Apple-simple, no jargon). */
function suggestionText(s: SuggestedCheck): string {
  switch (s.rule) {
    case 'not_null': return `${s.column} is never empty`;
    case 'not_blank': return `${s.column} is never blank`;
    case 'unique': return `${s.column} is unique`;
    case 'accepted_values': return `${s.column} is one of {${(s.values ?? []).join(', ')}}`;
    case 'range': return `${s.column} is in range ${s.min ?? '−∞'}–${s.max ?? '∞'}`;
    default: return s.column;
  }
}

/**
 * A tiny inline health-trend sparkline over the persisted runs. Pure SVG, no deps. A run
 * that measured nothing (score null) is drawn as a gap, never a fake 0 — the honesty
 * contract, visualised. Colour tracks the latest badge.
 */
function Sparkline({ points }: { points: TrendPoint[] }) {
  const scored = points.filter((p) => typeof p.score === 'number') as { ranAt: string; score: number; badge: QualityBadge }[];
  if (scored.length < 2) return null;
  const w = 120, h = 28, pad = 3;
  const n = points.length;
  const x = (i: number) => pad + (n === 1 ? 0 : (i / (n - 1)) * (w - 2 * pad));
  const y = (v: number) => pad + (1 - v / 100) * (h - 2 * pad);
  // One polyline segment per contiguous run of scored points (a null breaks the line).
  const segments: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (typeof p.score === 'number') cur.push(`${x(i).toFixed(1)},${y(p.score).toFixed(1)}`);
    else { if (cur.length) segments.push(cur.join(' ')); cur = []; }
  });
  if (cur.length) segments.push(cur.join(' '));
  const last = points[points.length - 1]?.badge ?? scored[scored.length - 1].badge;
  const stroke = last === 'failing' ? 'var(--danger, #d64545)' : last === 'passing' ? 'var(--ok, #2e9e6b)' : 'var(--muted, #999)';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Health trend" style={{ display: 'block' }}>
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** The dbt-style label the editor shows for a stored rule. */
function ruleText(c: DataCheck): string {
  const col = c.column ?? '';
  switch (c.rule) {
    case 'not_null': return `not_null(${col})`;
    case 'not_blank': return `not_blank(${col})`;
    case 'unique': return `unique(${col})`;
    case 'accepted_values': return `accepted_values(${col}, [${(c.values ?? []).join(', ')}])`;
    case 'range': return `range(${col}, ${c.min ?? ''}, ${c.max ?? ''})`;
    default: return c.name || 'check';
  }
}

type Dataset = {
  id: string;
  name: string;
  /** The FROZEN physical slug (present once a rename decoupled it from the name). */
  slug?: string;
  owner: string;
  domain: string;
  tier: 'dataset' | 'asset' | 'product';
  visibility: string;
  description: string;
  versions: { bronze: VersionState; silver: VersionState; gold: VersionState };
  columns: ColumnDoc[];
  measures: { name: string }[];
  /** The stored raw Gold build spec — re-hydrates the Gold panel so its joins/columns/
   *  measures stay visible + editable + rebuildable after a build. */
  goldSpec?: GoldSpec;
  /** Scheduled incremental sync (absent when none is set up). Presence gates the
   *  SyncPanel host — the panel fetches its own full state. */
  sync?: { schedule: { cron: string }; enabled: boolean };
  certification?: Certification;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};

/** Tile tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: Dataset['tier']): Visibility =>
  tier === 'asset' ? 'shared' : tier === 'product' ? 'certified' : 'personal';

/** Inline slug — mirrors store-fqn.ts without importing server code. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Bronze refreshed AFTER this layer was built ⇒ the layer is stale. A scheduled
 *  sync only rewrites Bronze (v1 surfaces staleness, never auto-rebuilds). */
function staleVsBronze(versions: Dataset['versions'], layer: 'silver' | 'gold'): boolean {
  const b = versions.bronze;
  const l = versions[layer];
  return Boolean(b.built && l.built && b.updatedAt && l.updatedAt && b.updatedAt > l.updatedAt);
}

function furthestBuilt(versions: Dataset['versions']): Layer | null {
  if (versions.gold.built) return 'gold';
  if (versions.silver.built) return 'silver';
  if (versions.bronze.built) return 'bronze';
  return null;
}

/** Tier-aware physical FQN — mirrors the server's builtLayerFqn: a personal dataset
 *  lives in the OWNER's `personal_<uid>` schema, a governed one in its (sanitized)
 *  domain schema. Never shows a table name that can't exist. */
/** The FROZEN physical slug — the pinned `slug` if a rename decoupled it, else
 *  `slug(name)`. Mirrors store-fqn.physicalSlug so the displayed FQN matches the real table. */
function physicalSlug(d: Dataset): string {
  return d.slug ?? slug(d.name);
}
function physicalFqn(d: Dataset, layer: Layer): string {
  const schema = d.tier === 'dataset' ? `personal_${slug(d.owner)}` : slug(d.domain);
  return `iceberg.${schema}.${layer}_${physicalSlug(d)}`;
}

/** Whether a dataset would be delivered to the Cube semantic layer (mirrors cubeDeliverable). */
function isCubeReady(d: Dataset): boolean {
  return d.tier !== 'dataset' && d.versions.gold.built;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

const TIER_BADGE: Record<Dataset['tier'], string> = { dataset: TIER_BADGE_CLASS.personal, asset: TIER_BADGE_CLASS.shared, product: TIER_BADGE_CLASS.certified };
const TIER_WORD: Record<Dataset['tier'], string> = { dataset: 'Personal dataset', asset: 'Data asset', product: 'Data product' };
// Display words for a dataset's stored visibility. Core (lib/core/scopes.ts) is the
// source of truth for scope vocabulary; these lowercase keys are this tab's own field
// values, mirrored to the same nouns ("Shared"→"Domain").
const VIS_WORD: Record<string, string> = { private: 'Private', domain: 'Domain', shared: 'Domain', public: 'Public' };

/** "Show the code" — the same Forgejo-versioned files the panels + agent edit. */
function CodeDrawer({ datasetId }: { datasetId: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState('dataset.yaml');
  const [content, setContent] = useState('');
  const [sha, setSha] = useState('');
  const [err, setErr] = useState('');
  const [savedNote, setSavedNote] = useState('');

  const loadFile = useCallback(async (p: string) => {
    setErr(''); setSavedNote('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/files?path=${encodeURIComponent(p)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not read file'); return; }
      setPath(p); setContent(data.content); setSha(data.sha);
    } catch (e) { setErr((e as Error).message); }
  }, [datasetId]);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/data/datasets/${datasetId}/files`, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) { setFiles(data.files ?? []); loadFile('dataset.yaml'); }
    })();
  }, [datasetId, loadFile]);

  const editable = path === 'dataset.yaml';
  const save = useCallback(async () => {
    setErr(''); setSavedNote('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/files`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content, sha }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Save failed'); return; }
      setSha(data.sha); setSavedNote('✓ saved — same source the panels and agent use');
    } catch (e) { setErr((e as Error).message); }
  }, [datasetId, path, content, sha]);

  return (
    <div className="code-drawer">
      <div className="chip-row" style={{ marginBottom: 8 }}>
        {files.map((f) => (
          <button key={f} className={`chip${f === path ? ' on' : ''}`} style={{ cursor: 'pointer' }} onClick={() => loadFile(f)}>{f}</button>
        ))}
      </div>
      <textarea className="mono" rows={14} value={content} readOnly={!editable}
        onChange={(e) => setContent(e.target.value)} spellCheck={false} />
      <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
        <div className="hint" style={{ marginTop: 0 }}>
          {editable ? 'dataset.yaml is the single source — edit here, the tiles + stages follow.' : 'Build materialises this native file; edit via the guided panel or the data agent.'}
          {savedNote ? <span className="ok-note"> {savedNote}</span> : null}
        </div>
        {editable ? <button className="btn" onClick={save}>Save</button> : null}
      </div>
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}

/* ───────────────────── Publish · connected-lists (build on this data) ─────────────────────
 * Three governed reverse-lists for the Publish stage: the metrics, dashboards and agent
 * systems that already build on THIS dataset. Each is fetched AS the current user through a
 * per-dataset GET route (RLS-filtered server-side), links out to the owning tab focused on
 * the item, and offers an inline "＋ New …" that opens that tab's creator pre-scoped to this
 * dataset. Fail-soft: a failed fetch shows a calm hint, never a crash or a fabricated row. */

type MetricRow = { id: string; name: string; type: string; tier: string; error?: string };
type DashboardRow = { id: string; name: string; charts: number };
type SystemRow = { id: string; name: string; agentCount: number };

/** Fetch a per-dataset list once (keyed on datasetId), fail-soft. Mirrors the file's other
 *  panels: a small useState + useEffect, no external data lib. `pick` reads the array off the
 *  JSON body so one hook serves all three lists. */
function useConnected<T>(datasetId: string, path: string, pick: (body: unknown) => T[]) {
  const [rows, setRows] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    setLoaded(false);
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/${path}`, { cache: 'no-store' });
        if (!res.ok) throw new Error();
        const body = await res.json();
        if (live) setRows(pick(body));
      } catch {
        if (live) setRows([]); // fail-soft — a calm empty list, never a crash
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, path]);
  return { rows, loaded };
}

/** The "build on this data" doorways for Publish — Metrics, Dashboards and Agent systems
 *  connected to this dataset, each with an inline create pre-scoped to it. */
function ConnectedBuild({ datasetId }: { datasetId: string }) {
  const metrics = useConnected<MetricRow>(datasetId, 'metrics', (b) => (b as { metrics?: MetricRow[] }).metrics ?? []);
  const dashboards = useConnected<DashboardRow>(datasetId, 'dashboards', (b) => (b as { dashboards?: DashboardRow[] }).dashboards ?? []);
  const systems = useConnected<SystemRow>(datasetId, 'agents', (b) => (b as { systems?: SystemRow[] }).systems ?? []);

  return (
    <>
      {/* Metrics defined on this dataset. */}
      <div className="section-title" style={{ marginTop: 24 }}>
        Metrics
        {metrics.rows.length > 0 ? <span className="count-pill">{metrics.rows.length}</span> : null}
      </div>
      {metrics.rows.length > 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {metrics.rows.map((m) => (m.error ? (
            <span className="chip" key={m.id} title={m.error} style={{ opacity: 0.6 }}>{m.name} · {m.error}</span>
          ) : (
            <a className="chip" key={m.id} href={`/metrics?focus=${encodeURIComponent(m.id)}`} style={{ textDecoration: 'none' }}>{m.name} · {m.type}</a>
          )))}
        </div>
      ) : metrics.loaded ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>No metrics defined on this dataset yet.</p>
      ) : null}
      <div className="row" style={{ marginBottom: 4 }}>
        <a className="btn ghost sm" href={`/metrics?new=1&dataset=${encodeURIComponent(datasetId)}`} title="Define a new metric on this dataset in the Metrics tab">
          ＋ New metric →
        </a>
      </div>

      {/* Dashboards bound to this dataset's Cube view. */}
      <div className="section-title" style={{ marginTop: 20 }}>
        Dashboards
        {dashboards.rows.length > 0 ? <span className="count-pill">{dashboards.rows.length}</span> : null}
      </div>
      {dashboards.rows.length > 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {dashboards.rows.map((d) => (
            <a className="chip" key={d.id} href={`/dashboards?focus=${encodeURIComponent(d.id)}`} style={{ textDecoration: 'none' }}>{d.name} · {d.charts} chart{d.charts === 1 ? '' : 's'}</a>
          ))}
        </div>
      ) : dashboards.loaded ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>No dashboards built on this dataset yet.</p>
      ) : null}
      <div className="row" style={{ marginBottom: 4 }}>
        <a className="btn ghost sm" href={`/dashboards?new=1&dataset=${encodeURIComponent(datasetId)}`} title="Build a new dashboard on this dataset in the Dashboards tab">
          ＋ New dashboard →
        </a>
      </div>

      {/* Agent systems that consume this dataset. */}
      <div className="section-title" style={{ marginTop: 20 }}>
        Use in an agent system
        {systems.rows.length > 0 ? <span className="count-pill">{systems.rows.length}</span> : null}
      </div>
      {systems.rows.length > 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {systems.rows.map((s) => (
            <a className="chip" key={s.id} href={`/agents?system=${encodeURIComponent(s.id)}`} style={{ textDecoration: 'none' }}>{s.name} · {s.agentCount} agent{s.agentCount === 1 ? '' : 's'}</a>
          ))}
        </div>
      ) : systems.loaded ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>No agent systems use this dataset yet.</p>
      ) : null}
      <div className="row" style={{ marginBottom: 4 }}>
        <a className="btn ghost sm" href="/agents?system=new" title="Build a new agent system that uses this dataset in the Agents tab">
          Use in an agent system →
        </a>
      </div>
    </>
  );
}

/**
 * The Data guided builder — Ingest · Define · Harmonize · Validate · Publish (5 stages) on
 * the OS-wide staged primitive (lib/core/stages.ts + components/core/StageShell.tsx; the
 * Agents SimpleBuilder is the reference adoption, Dashboards the closest sibling). This
 * REPLACES the old 1114-line single-scroll DatasetDetail: every one of its bodies (row
 * preview, docs + quality editor, BronzePanel, RefinePanel, GoldJoinPanel, ExplorePanel,
 * MetricsPanel, the sharing/promote block, LineagePanel) is re-hosted UNCHANGED under the
 * stage it belongs to — nothing is rewritten, only re-arranged behind the stepper in
 * medallion order. Opening a dataset lands it at the right stage on REAL state: a raw
 * dataset opens at Ingest, a Bronze one at Define, a Silver one at Harmonize, a materialized
 * one at Validate (the natural "check quality then query" entry).
 */
export default function DataBuilder({
  datasetId,
  onBack,
}: {
  datasetId: string;
  onBack: () => void;
}) {
  const { user } = useUser();
  const { notifyApprovalFiled } = useApprovalNotifier();

  /* ── Simple ⇄ Developer view mode ── */
  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(DATA_MODE_KEY);
    if (saved === 'simple' || saved === 'developer') setViewMode(saved);
  }, []);
  const setModePersisted = (m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(DATA_MODE_KEY, m);
  };

  /* ── Published landing: a published dataset (shared to Domain or certified to Company)
     opens in a calm PREVIEW + TALK-TO-DATA view — most people want to USE it, not rebuild
     it. A prominent "Edit data stages" button drops into the full 5-stage builder. */
  const [builderOpen, setBuilderOpen] = useState(false);

  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [checks, setChecks] = useState<DataCheck[]>([]);
  const [loadErr, setLoadErr] = useState('');
  // Catalog handshake (folded in — no separate Catalog tab): the OpenMetadata deep link.
  const [omUrl, setOmUrl] = useState<string | null>(null);

  // ---- docs editing ----
  const [desc, setDesc] = useState('');
  const [cols, setCols] = useState<ColumnDoc[]>([]);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsErr, setDocsErr] = useState('');
  const [docsOk, setDocsOk] = useState('');
  // ---- AI "Clean it up" proposal — filled into the Silver RefinePanel when it arrives ----
  const [cleanProposal, setCleanProposal] = useState<CleanDraft | null>(null);

  // ---- data-quality rules editor ----
  const [ruleKind, setRuleKind] = useState<DataCheckRule>('not_null');
  const [ruleColumn, setRuleColumn] = useState('');
  const [ruleValues, setRuleValues] = useState(''); // comma-separated (accepted_values)
  const [ruleMin, setRuleMin] = useState('');
  const [ruleMax, setRuleMax] = useState('');
  const [checksBusy, setChecksBusy] = useState(false);
  const [checksErr, setChecksErr] = useState('');
  // ---- run results ----
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [badge, setBadge] = useState<QualityBadge | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState('');
  // ---- AI-proposed remediations: which failing rule's fix panel is open ----
  const [fixOpen, setFixOpen] = useState<string | null>(null);
  // ---- health score + persisted trend + profile-driven suggestions (Validate) ----
  const [health, setHealth] = useState<HealthScore | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedCheck[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [acceptingAll, setAcceptingAll] = useState(false);
  // ---- heuristic monitors (freshness/volume/schema), on by default (Validate) ----
  const [monitors, setMonitors] = useState<MonitorToggle[]>([]);
  const [monitorBusy, setMonitorBusy] = useState('');

  // ---- row preview (governed SELECT * LIMIT 50) ----
  const [preview, setPreview] = useState<RowPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState('');

  // ---- configuration drawer (dbt SQL / dataset.yaml) ----
  const [showCode, setShowCode] = useState(false);

  // ---- inline rename of the display name (edit-gated; the physical slug is frozen
  //      server-side so no Iceberg/Cube/dbt table ever moves) ----
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameErr, setRenameErr] = useState('');

  // ---- sharing / promotion (mirrors Files: gate hint + button + request status) ----
  const [promote, setPromote] = useState<PromoteStatus | null>(null);
  const [certifyPending, setCertifyPending] = useState(false);
  const [shareErr, setShareErr] = useState('');
  const [shareBusy, setShareBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const [dsRes, chkRes] = await Promise.all([
        fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' }),
        fetch(`/api/data/datasets/${datasetId}/checks`, { cache: 'no-store' }),
      ]);
      const dsData = await dsRes.json();
      if (!dsRes.ok) { setLoadErr(dsData.error ?? 'Could not load dataset'); return; }
      setDataset(dsData.dataset);
      setDesc(dsData.dataset.description ?? '');
      setCols(
        dsData.dataset.columns?.length
          ? dsData.dataset.columns
          : [{ name: '', description: '' }],
      );
      if (chkRes.ok) {
        const chkData = await chkRes.json();
        setChecks(chkData.checks ?? []);
      }
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, [datasetId]);

  useEffect(() => { load(); }, [load]);

  // Sharing gate + in-flight request — the SAME source the Promote panel uses.
  const loadPromote = useCallback(async () => {
    try {
      const [pRes, cRes] = await Promise.all([
        fetch(`/api/data/datasets/${datasetId}/promote`, { cache: 'no-store' }),
        fetch(`/api/data/datasets/${datasetId}/certify`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPromote(await pRes.json());
      if (cRes.ok) setCertifyPending((await cRes.json()).request?.status === 'pending');
    } catch { /* sharing status is best-effort; the builder stands without it */ }
  }, [datasetId]);
  useEffect(() => { loadPromote(); }, [loadPromote]);

  // Creator/Builder file a promotion REQUEST (a different Builder approves in Governance).
  const requestPromote = useCallback(async () => {
    setShareErr(''); setShareBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const data = await res.json();
      if (!res.ok) { setShareErr(data.error ?? 'Could not request promotion'); return; }
      const approval = data.approval as FiledApproval | undefined;
      if (approval?.id) notifyApprovalFiled(approval, 'dataset', () => { void Promise.all([loadPromote(), load()]); });
      await Promise.all([loadPromote(), load()]);
    } catch (e) { setShareErr((e as Error).message); } finally { setShareBusy(false); }
  }, [datasetId, loadPromote, load, notifyApprovalFiled]);

  // An Admin certifies a Shared asset directly; a Creator/Builder files a request.
  const certifyAsset = useCallback(async (mode: 'certify' | 'request') => {
    setShareErr(''); setShareBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/certify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: mode }),
      });
      const data = await res.json();
      if (!res.ok) { setShareErr(data.error ?? 'Could not certify'); return; }
      const approval = data.approval as FiledApproval | undefined;
      if (approval?.id) notifyApprovalFiled(approval, 'dataset', () => { void Promise.all([loadPromote(), load()]); });
      await Promise.all([loadPromote(), load()]);
    } catch (e) { setShareErr((e as Error).message); } finally { setShareBusy(false); }
  }, [datasetId, loadPromote, load, notifyApprovalFiled]);

  // Best-effort OpenMetadata deep link from the catalog union.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/catalog', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { assets?: { datasetId?: string; omUrl?: string }[] };
        const hit = (data.assets ?? []).find((a) => a.datasetId === datasetId && a.omUrl);
        if (!cancelled && hit?.omUrl) setOmUrl(hit.omUrl);
      } catch { /* catalog offline — the builder stands on the registry alone */ }
    })();
    return () => { cancelled = true; };
  }, [datasetId]);

  const saveDocs = useCallback(async () => {
    setDocsErr(''); setDocsOk(''); setDocsBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: desc, columns: cols.filter((c) => c.name.trim()) }),
      });
      const data = await res.json();
      if (!res.ok) { setDocsErr(data.error ?? 'Could not save'); return; }
      setDocsOk('✓ saved');
      setDataset((prev) => prev ? { ...prev, description: data.dataset.description, columns: data.dataset.columns } : prev);
    } catch (e) {
      setDocsErr((e as Error).message);
    } finally {
      setDocsBusy(false);
    }
  }, [datasetId, desc, cols]);

  const addRuleWith = useCallback(async (
    kind: DataCheckRule, column: string,
    extra: { values?: string[]; min?: number; max?: number } = {},
  ) => {
    if (!column.trim()) { setChecksErr('Pick a column for the rule.'); return; }
    setChecksErr(''); setChecksBusy(true);
    const payload: Record<string, unknown> = { rule: kind, column: column.trim(), ...extra };
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setChecksErr(data.error ?? 'Could not add rule'); return; }
      setChecks((prev) => [...prev, data.check]);
    } catch (e) {
      setChecksErr((e as Error).message);
    } finally {
      setChecksBusy(false);
    }
  }, [datasetId]);

  const addRule = useCallback(async () => {
    const extra: { values?: string[]; min?: number; max?: number } = {};
    if (ruleKind === 'accepted_values') {
      extra.values = ruleValues.split(',').map((v) => v.trim()).filter(Boolean);
    }
    if (ruleKind === 'range') {
      if (ruleMin.trim() !== '') extra.min = Number(ruleMin);
      if (ruleMax.trim() !== '') extra.max = Number(ruleMax);
    }
    await addRuleWith(ruleKind, ruleColumn, extra);
    if (!checksErr) { setRuleColumn(''); setRuleValues(''); setRuleMin(''); setRuleMax(''); }
  }, [ruleKind, ruleColumn, ruleValues, ruleMin, ruleMax, addRuleWith, checksErr]);

  const deleteRule = useCallback(async (checkId: string) => {
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkId }),
      });
      const data = await res.json();
      if (res.ok) {
        setChecks(data.checks ?? []);
        setResults((prev) => { const n = { ...prev }; delete n[checkId]; return n; });
      }
    } catch { /* leave the row — a failed delete never fabricates state */ }
  }, [datasetId]);

  // Load the Validate DQ surface: persisted health trend + latest run + the deterministic
  // profile→rule suggestions. Governed + read-only; a miss degrades to empty, never faked.
  const loadDq = useCallback(async () => {
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/dq`, { cache: 'no-store' });
      if (!res.ok) return; // no DQ surface (not materialised / not a viewer) — stay quiet
      const data = await res.json();
      setSuggestions((data.suggestions ?? []) as SuggestedCheck[]);
      setTrend((data.trend ?? []) as TrendPoint[]);
      setMonitors((data.monitors ?? []) as MonitorToggle[]);
      const latest = data.latest as { badge?: QualityBadge; healthScore?: number | null; ranAt?: string } | null;
      // Seed the header from the last persisted run so re-opening shows the real state,
      // not a blank — without claiming a fresh run happened.
      if (latest && !ranAt) {
        if (typeof latest.healthScore !== 'undefined') setHealth((h) => h ?? { score: latest.healthScore ?? null, status: latest.badge ?? 'unknown', passing: 0, failing: 0, notRun: 0 });
        if (latest.badge && !badge) setBadge(latest.badge);
        if (latest.ranAt) setRanAt((r) => r ?? latest.ranAt!);
      }
    } catch { /* the surface is additive — the editor + Run still work */ }
  }, [datasetId, ranAt, badge]);
  useEffect(() => { void loadDq(); }, [loadDq]);

  // Accept ONE suggested check through the governed POST /checks path (same gate the
  // manual editor uses), then drop it from the list.
  const acceptSuggestion = useCallback(async (s: SuggestedCheck) => {
    setSuggestBusy(true);
    try {
      const extra: { values?: string[]; min?: number; max?: number } = {};
      if (s.rule === 'accepted_values' && s.values) extra.values = s.values;
      if (s.rule === 'range') { if (typeof s.min === 'number') extra.min = s.min; if (typeof s.max === 'number') extra.max = s.max; }
      await addRuleWith(s.rule, s.column, extra);
      setSuggestions((prev) => prev.filter((x) => !(x.rule === s.rule && x.column === s.column)));
    } finally {
      setSuggestBusy(false);
    }
  }, [addRuleWith]);

  // Accept every suggestion (idempotent — the route dedupes; the list clears as each lands).
  const acceptAllSuggestions = useCallback(async () => {
    setAcceptingAll(true);
    try {
      for (const s of suggestions) {
        const extra: { values?: string[]; min?: number; max?: number } = {};
        if (s.rule === 'accepted_values' && s.values) extra.values = s.values;
        if (s.rule === 'range') { if (typeof s.min === 'number') extra.min = s.min; if (typeof s.max === 'number') extra.max = s.max; }
        await addRuleWith(s.rule, s.column, extra);
      }
      setSuggestions([]);
    } finally {
      setAcceptingAll(false);
    }
  }, [suggestions, addRuleWith]);

  // Toggle a heuristic monitor (freshness/volume/schema). Governed by the canEdit gate on
  // the route; the server returns the authoritative config, so the UI mirrors stored state.
  const toggleMonitor = useCallback(async (kind: MonitorKind, enabled: boolean) => {
    setMonitorBusy(kind);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/dq`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, enabled }),
      });
      if (res.ok) {
        const data = await res.json();
        setMonitors((data.monitors ?? []) as MonitorToggle[]);
      }
    } finally {
      setMonitorBusy('');
    }
  }, [datasetId]);

  const runChecks = useCallback(async () => {
    setRunErr(''); setRunning(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run' }),
      });
      const data = await res.json();
      if (!res.ok) { setRunErr(data.error ?? 'Could not run checks'); return; }
      const byId: Record<string, CheckResult> = {};
      for (const r of (data.results ?? []) as CheckResult[]) byId[r.id] = r;
      setResults(byId);
      setBadge(data.badge ?? 'unknown');
      setRanAt(data.ranAt ?? null);
      if (data.health) setHealth(data.health as HealthScore);
      void loadDq(); // refresh the persisted trend + re-derived suggestions after a run
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [datasetId, loadDq]);

  // Governed 50-row preview — the SAME OPA-checked read path.
  const loadPreview = useCallback(async () => {
    setPreviewErr(''); setPreviewing(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/preview?limit=50`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setPreviewErr(data.error ?? 'Could not preview rows'); return; }
      setPreview(data as RowPreview);
    } catch (e) {
      setPreviewErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }, [datasetId]);
  useEffect(() => { void loadPreview(); }, [loadPreview]);

  // The governed 50-row data preview, as a reusable block so EVERY stage can show
  // "what's in the table right now" — Bronze/Silver had it; Gold, Validate and Publish
  // now get the same view. It always reads the highest built layer through the governed
  // Trino path (OPA-checked); nothing is shown until a layer is built.
  const rowPreviewBlock = (heading: string, subtitle: string) => (
    <>
      <div className="section-title" style={{ marginTop: 22 }}>
        {heading}
        <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={loadPreview} disabled={previewing}>
          {previewing ? <span className="spin" /> : 'Refresh preview'}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{subtitle}</p>
      {previewErr ? <div className="error" style={{ marginBottom: 10 }}>{previewErr}</div> : null}
      {preview ? (
        preview.available ? (
          <>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              First {preview.rowCount} row{preview.rowCount === 1 ? '' : 's'} · {preview.layer}{' · '}<span className="mono" style={{ fontSize: 10 }}>{preview.fqn}</span>
            </p>
            {preview.columns.length > 0 ? (
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table>
                  <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>No rows to show.</p>}
          </>
        ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>{preview.reason}</p>
      ) : null}
    </>
  );

  // Apply an assistant Define draft into the docs + quality-rule editors (never auto-saves).
  const applyDraft = useCallback((draft: DefineDraft) => {
    if (typeof draft.description === 'string' && draft.description.trim()) setDesc(draft.description.trim());
    if (Array.isArray(draft.columns) && draft.columns.length > 0) {
      const known = new Map(cols.filter((c) => c.name.trim()).map((c) => [c.name, c.description]));
      for (const c of draft.columns) if (typeof c?.name === 'string' && c.name.trim()) known.set(c.name.trim(), c.description ?? '');
      const merged = Array.from(known, ([name, description]) => ({ name, description }));
      setCols(merged.length ? merged : [{ name: '', description: '' }]);
    }
    // File the suggested quality rules (each validated + governed by the checks route).
    for (const chk of draft.checks ?? []) {
      if (chk && RULE_KINDS.has(chk.rule as DataCheckRule) && typeof chk.column === 'string' && chk.column.trim()) {
        const extra: { values?: string[]; min?: number; max?: number } = {};
        if (chk.rule === 'accepted_values' && Array.isArray(chk.values)) extra.values = chk.values.filter((v) => typeof v === 'string');
        if (chk.rule === 'range') { if (typeof chk.min === 'number') extra.min = chk.min; if (typeof chk.max === 'number') extra.max = chk.max; }
        void addRuleWith(chk.rule as DataCheckRule, chk.column, extra);
      }
    }
  }, [cols, addRuleWith]);

  // ── Live ctx off REAL dataset state — the stage gates/✓ read this, never faked ──
  const ctx: DataCtx = useMemo(() => {
    if (!dataset) return { named: false, bronzeBuilt: false, silverBuilt: false, goldBuilt: false, refined: false, materialized: false };
    const v = dataset.versions;
    return {
      named: !!dataset.name.trim(),
      bronzeBuilt: v.bronze.built,
      silverBuilt: v.silver.built,
      goldBuilt: v.gold.built,
      refined: v.silver.built || v.gold.built,
      materialized: v.bronze.built || v.silver.built || v.gold.built,
    };
  }, [dataset]);

  // Open on the first REACHABLE stage from real state, nothing pre-marked: a fresh dataset
  // opens at Ingest; a Bronze-only one at Define; a Silver-only one at Harmonize; a
  // materialized one at Validate (the natural "check quality then query" entry).
  const [stage, setStage] = useState<StageState<DataStageId>>(() => initialStageState(DATA_STAGES));

  // Ground "Ask the OS" on the dataset + stage currently open here, so a request like
  // "document the columns" acts on THIS dataset at THIS stage without asking for an id.
  usePublishPageContext({
    tab: 'data',
    stage: stage.current,
    artifactType: 'dataset',
    artifactId: datasetId,
    artifactName: dataset?.name,
  });
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (landed || !dataset) return;
    const start: DataStageId =
      ctx.materialized ? 'validate'
      : ctx.silverBuilt ? 'harmonize'
      : ctx.bronzeBuilt ? 'define'
      : 'ingest';
    setStage((s) => ({ ...s, current: start }));
    setLanded(true);
  }, [dataset, ctx, landed]);

  // When a guided panel COMMITS its layer (onCommitted), it requests an advance to
  // the next stage. The build is async (reload → fresh ctx), so we advance in an
  // EFFECT once the committed stage's condition is met — this is what makes the
  // panel's "Continue" actually move the stepper forward (markDone only sets the ✓).
  const [pendingAdvance, setPendingAdvance] = useState<DataStageId | null>(null);
  useEffect(() => {
    if (!pendingAdvance) return;
    const def = DATA_STAGES.find((d) => d.id === pendingAdvance);
    if (!def?.completed || !def.completed(ctx)) return; // wait for the reload to reflect the build
    setStage((s) => (s.current === pendingAdvance ? advance(DATA_STAGES, s, ctx) : s));
    setPendingAdvance(null);
  }, [ctx, pendingAdvance]);

  if (loadErr) {
    return (
      <>
        <button className="btn ghost" onClick={onBack}>← Datasets</button>
        <div className="error" style={{ marginTop: 14 }}>{loadErr}</div>
      </>
    );
  }
  if (!dataset) return <div className="stub-page">Opening dataset…</div>;

  const layer = furthestBuilt(dataset.versions);
  const fqn = layer ? physicalFqn(dataset, layer) : null;
  const cubeReady = isCubeReady(dataset);
  const published = !!dataset.certification;
  // "Published" for the landing view = shared beyond the owner's private space (promoted
  // to Domain = asset, or certified to Company = product). Such a dataset opens in the
  // preview+talk landing until the user clicks "Edit data stages".
  const isPublished = dataset.tier === 'asset' || dataset.tier === 'product';
  const showLanding = isPublished && !builderOpen;
  const canEdit = !!user && canManageArtifact(user, { owner: dataset.owner, domain: dataset.domain });
  const isAdmin = user?.role === 'admin';

  const builtLayers = (['bronze', 'silver', 'gold'] as Layer[]).filter((l) => dataset.versions[l].built);
  const colNames = dataset.columns.map((c) => c.name).filter(Boolean);
  const canRefineSilver = dataset.versions.bronze.built;
  const canHarmonizeGold = dataset.versions.silver.built;
  const talk = TALK_PRESENTATION.data;

  // A build committed → reload the honest built state (advances the gates).
  const onBuilt = () => { void load(); };
  // Record a stage's ✓ when its work settles in-stage (gated on the live condition).
  const settle = (id: DataStageId) => setStage((s) => markDone(s, id));
  // A panel committed its layer: reload the real state, record the ✓, and REQUEST
  // an advance to the next stage (the effect moves the stepper once the build lands).
  const commitStage = (id: DataStageId) => { onBuilt(); settle(id); setPendingAdvance(id); };
  // Like commitStage but STAYS on the current step (no auto-advance): reload + record the
  // ✓ so the built state shows, and let the user explore the result and choose to move on.
  // The Gold step uses this so building Gold no longer throws the user into Data Quality.
  const commitStageStay = (id: DataStageId) => { onBuilt(); settle(id); };
  // The user explicitly chose to move on from a settled step → advance the stepper.
  const continueFrom = (id: DataStageId) => setPendingAdvance(id);

  // Rename the dataset (display name only). The store freezes the physical slug before
  // the name changes, so every FQN/Cube/dbt identity stays pinned to the real table.
  const rename = async () => {
    const name = nameDraft.trim();
    setRenameErr('');
    if (!name) { setRenaming(false); return; }
    const res = await fetch(`/api/data/datasets/${datasetId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRenameErr(d.error ?? 'Rename failed'); return; }
    setRenaming(false);
    await load();
  };

  return (
    <ConfirmProvider>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost" onClick={onBack}>← Datasets</button>
        {showLanding ? (
          // The published landing: one prominent doorway into the full pipeline.
          <button className="btn primary" onClick={() => setBuilderOpen(true)} title="Open the 5-stage builder to edit this dataset's pipeline">
            ✎ Edit data stages
          </button>
        ) : isPublished ? (
          // Editing a published dataset — offer the way back to its calm landing, plus the mode toggle.
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <button className="btn ghost sm" onClick={() => setBuilderOpen(false)}>← Done editing</button>
            <BuilderModeToggle
              mode={viewMode}
              onChange={setModePersisted}
              developerHint="The raw technical surface — dbt/Cube artifacts, FQNs, RLS summary"
            />
          </div>
        ) : (
          <BuilderModeToggle
            mode={viewMode}
            onChange={setModePersisted}
            developerHint="The raw technical surface — dbt/Cube artifacts, FQNs, RLS summary"
          />
        )}
      </div>

      {/* ── Header + status chips (always visible, above the stepper) ── */}
      <div className="stepper-head">
        {renaming ? (
          <span className="rename-inline">
            <input
              className="rename-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(false); }}
              aria-label="Dataset name"
            />
            <button className="btn primary sm" onClick={() => void rename()}>Save</button>
            <button className="btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button>
          </span>
        ) : (
          <h2 className="stepper-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', display: 'flex', alignItems: 'center', gap: 10 }}>
            {dataset.name}
            {/* Rename must be DISCOVERABLE — a labelled button, not a bare glyph
                (user feedback 2026-07-31: the pencil-only affordance read as missing). */}
            {canEdit ? (
              <button
                className="btn ghost sm"
                style={{ flex: 'none' }}
                onClick={() => { setNameDraft(dataset.name); setRenameErr(''); setRenaming(true); }}
                title="Rename this dataset (the physical table slug stays stable)"
                aria-label="Rename this dataset"
              >✎ Rename</button>
            ) : null}
          </h2>
        )}
        <span className={`badge ${TIER_BADGE[dataset.tier]}`}>{TIER_WORD[dataset.tier]}</span>
        <span className="muted" style={{ fontSize: 13 }}>{dataset.owner} · {dataset.domain}</span>
        {/* Stable ID + physical (frozen) table slug — the display-name vs physical-name
            distinction, so two same-named datasets are distinguishable and the physical
            table is transparent even after a rename. */}
        <span className="mono muted" style={{ fontSize: 11 }} title="Dataset ID">{dataset.id}</span>
        <span className="mono muted" style={{ fontSize: 11 }} title="Physical table name (frozen — unaffected by rename)">table: {physicalSlug(dataset)}</span>
        {renameErr && <span className="badge err" style={{ fontSize: 11 }}>{renameErr}</span>}
        {dataset.tier !== 'dataset' ? <DomainTag domain={dataset.domain} /> : null}
        {/* Lifecycle (Archive/Restore/Delete/Versions) lives in the persistent detail header so
            it is reachable from ANY stage — not buried in Publish. Governance unchanged (canEdit). */}
        {canEdit ? (
          <div style={{ marginLeft: 'auto' }}>
            <LifecycleActions
              id={dataset.id}
              name={dataset.name}
              kind="dataset"
              visibility={lcVis(dataset.tier)}
              archived={!!dataset.archived}
              api={`/api/data/datasets/${dataset.id}`}
              onChanged={() => { if (dataset.archived) onBack(); else void load(); }}
              showVersions
              compact
            />
          </div>
        ) : null}
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {layer ? (
          <span className="status-chip s-searchable" title={`Physical table: ${fqn}`} style={{ cursor: 'default' }}>
            ✓ materialized · {layer} · <span className="mono" style={{ fontSize: 10 }}>{fqn}</span>
          </span>
        ) : (
          <span className="status-chip s-stored" title="No medallion layer built yet — Ingest a file or extract" style={{ cursor: 'default' }}>
            not materialized — no layer built yet
          </span>
        )}
        <span className={`badge ${TIER_BADGE[dataset.tier]}`} style={{ alignSelf: 'center' }} title={`Tier: ${dataset.tier} · Visibility: ${dataset.visibility}`}>
          {VIS_WORD[dataset.visibility] ?? dataset.visibility}
        </span>
        {cubeReady ? (
          <span className="status-chip s-searchable" title="Gold table governed + built — Cube model sync can deliver it" style={{ cursor: 'default' }}>✓ Cube model ready</span>
        ) : (
          <span className="status-chip s-stored" title={dataset.tier === 'dataset' ? 'Cube model: promote to a data asset and build Gold first' : 'Cube model: build the Gold layer first'} style={{ cursor: 'default' }}>Cube model not ready</span>
        )}
        {omUrl ? (
          <a className="status-chip s-searchable" href={omUrl} target="_blank" rel="noopener noreferrer" title="Open this dataset's entity in the OpenMetadata catalog">catalog · OpenMetadata ↗</a>
        ) : null}
        {published ? (
          <span className={`badge cert-${dataset.certification!.level}`} title={`Certified ${dataset.certification!.level} by ${dataset.certification!.by} on ${formatDate(dataset.certification!.at)}`} style={{ cursor: 'default' }}>
            ✓ certified data product · {dataset.certification!.level}
          </span>
        ) : (
          <span className="status-chip s-stored" title={dataset.tier === 'product' ? 'Certification badge present' : 'Not yet a certified data product'} style={{ cursor: 'default' }}>not published</span>
        )}
      </div>

      {showLanding ? (
        // ── Published landing: preview + Talk to Data (use it, don't rebuild it) ──
        <div>
          <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
            This dataset is <strong>published</strong>. Preview it and ask it questions below — or use <strong>✎ Edit data stages</strong> (top-right) to open the full 5-stage pipeline.
          </p>
          {rowPreviewBlock('Data preview', 'The first 50 rows of the published table, read through the governed Trino path under your own row security.')}
          <div style={{ marginTop: 24 }}>
            <TalkTo tab="data" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
          </div>
          {/* What's already built on this data — metrics, dashboards, agent systems. */}
          <ConnectedBuild datasetId={dataset.id} />
        </div>
      ) : viewMode === 'simple' ? (
      <StageShell
        stages={DATA_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Dataset stages"
        // The three BUILD stages own their continue: Ingest auto-advances on a landed
        // upload, Silver/Gold show a big "Continue →" only after a successful build.
        // The shell's bare "next →" there reads as the primary action but builds
        // nothing — hide it. Stages stay voluntarily skippable via the rail on top.
        hideNextFor={['ingest', 'define', 'harmonize']}
      >
        {/* ─────────────── Ingest ─────────────── */}
        {stage.current === 'ingest' ? (
          <div {...anchorAttr(ANCHORS.data.load)}>
            {canEdit ? (
              <BronzePanel
                datasetId={dataset.id}
                datasetName={dataset.name}
                onCommitted={() => commitStage('ingest')}
              />
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>Only the owner and domain admins can bring in data.</p>
            )}

            {/* Keep this in sync — schedule + history for a warehouse-synced Bronze. */}
            {dataset.sync ? (
              <SyncPanel datasetId={dataset.id} canEdit={canEdit} columns={colNames} />
            ) : null}

            {/* Raw shape — the SAME governed rows/columns statistics treatment the Silver
                and Gold builders show (ExplorePanel: row/column counts, completeness,
                distinct, range), honestly labeled Bronze. Stats only here — the governed
                50-row preview below stays the raw-rows view. */}
            {dataset.versions.bronze?.built ? (
              <>
                <div className="section-title" style={{ marginTop: 22 }}>Your Bronze table</div>
                <ExplorePanel datasetId={dataset.id} builtLayers={['bronze']} showPreview={false} />
              </>
            ) : null}

            {/* Something went wrong bringing data in → one big AI explainer, right where
                the error shows (the old bottom "Assistant" box, built into the flow). */}
            {previewErr || (preview && !preview.available) ? (
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
                <AiAction
                  datasetId={dataset.id} stage="ingest" cta="Explain this error"
                  title="AI explains this ingest error in plain language"
                  payload={() => ({ name: dataset.name, reason: previewErr || (preview && !preview.available ? preview.reason : '') })}
                />
              </div>
            ) : null}

            {/* Raw preview of what landed — the governed SELECT * LIMIT 50. */}
            {rowPreviewBlock('Raw preview', 'A read-only scan of the first 50 rows through the governed query path (Trino, OPA-checked). Nothing is previewed until a layer is built.')}
          </div>
        ) : null}

        {/* ─────────────── Define ─────────────── */}
        {stage.current === 'define' ? (
          <div {...anchorAttr(ANCHORS.data.document)}>
            {/* AI, built into the flow: two big actions at the top of the stage — draft the
                documentation, or fill the Silver cleaning plan below ("Clean it up"). */}
            {canEdit ? (
              <div className="row" style={{ justifyContent: 'flex-end', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
                <AiAction<DefineDraft>
                  datasetId={dataset.id} stage="define" cta="Draft documentation"
                  title="AI drafts the description, column notes and quality rules from the schema"
                  payload={() => ({ name: dataset.name, prompt: desc, columns: colNames.length ? colNames : cols.map((c) => c.name).filter(Boolean) })}
                  onDraft={applyDraft}
                  successText="Drafted the description, column notes and quality rules — review them below."
                />
                <AiAction<CleanDraft>
                  datasetId={dataset.id} stage="clean" cta="Clean it up"
                  title={canRefineSilver ? 'AI fills the Silver cleaning plan below — types, trims, key, dedupe' : 'Bring in a Bronze layer first (in Ingest)'}
                  disabled={!canRefineSilver}
                  payload={() => ({ name: dataset.name, prompt: desc, columns: colNames })}
                  onDraft={setCleanProposal}
                  successText="Cleaning plan filled in below — review it, then Build Silver."
                />
              </div>
            ) : null}
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Bronze is in — now the columns are real. Describe what each column means, then clean and conform the data into the Silver layer.
            </p>
            {canEdit ? (
              <div className="guided-panel" style={{ marginBottom: 16 }}>
                <label className="muted" style={{ fontSize: 12.5 }}>What is this dataset?</label>
                <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="One line a teammate in another domain would understand." />
                <div className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>Column meanings</div>
                {cols.map((c, i) => (
                  <div className="row" key={i} style={{ gap: 8, marginBottom: 6 }}>
                    <input style={{ maxWidth: 180 }} placeholder="column" value={c.name}
                      onChange={(e) => setCols((cs) => cs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <input style={{ flex: 1 }} placeholder="what it means" value={c.description}
                      onChange={(e) => setCols((cs) => cs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                    <button type="button" className="btn ghost sm" onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))} aria-label="Remove column">×</button>
                  </div>
                ))}
                <button className="btn ghost sm" onClick={() => setCols((cs) => [...cs, { name: '', description: '' }])}>+ Column</button>
                {docsErr ? <div className="error" style={{ marginTop: 8 }}>{docsErr}</div> : null}
                <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
                  <button className="btn" onClick={() => { void saveDocs().then(() => settle('define')); }} disabled={docsBusy}>
                    {docsBusy ? <span className="spin" /> : 'Save documentation'}
                  </button>
                  {docsOk ? <span className="ok-note" style={{ fontSize: 12.5 }}>{docsOk}</span> : null}
                </div>
              </div>
            ) : (
              <>
                <p style={{ margin: '0 0 10px', color: dataset.description ? 'var(--text)' : 'var(--text-faint)', fontSize: 14 }}>
                  {dataset.description || 'No description yet.'}
                </p>
                {dataset.columns.length > 0 ? (
                  <div className="table-wrap" style={{ marginBottom: 16 }}>
                    <table>
                      <thead><tr><th>Column</th><th>Description</th></tr></thead>
                      <tbody>
                        {dataset.columns.map((c) => (
                          <tr key={c.name}><td className="mono" style={{ whiteSpace: 'nowrap' }}>{c.name}</td><td className="muted" style={{ whiteSpace: 'normal' }}>{c.description || '—'}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>No column docs yet.</p>}
              </>
            )}

            {/* Silver build — clean and conform Bronze into Silver. */}
            {canEdit ? (
              <>
                <div className="section-title" style={{ marginTop: 4 }} {...anchorAttr(ANCHORS.data.clean)}>
                  Clean it up — Silver
                  <span className="hint" style={{ margin: '0 0 0 10px' }}>dbt transformations on your Bronze data</span>
                </div>
                {staleVsBronze(dataset.versions, 'silver') ? (
                  <p className="hint" style={{ margin: '0 0 10px' }}>
                    Bronze has newer data than Silver ({fmtDate(dataset.versions.bronze.updatedAt)} vs {fmtDate(dataset.versions.silver.updatedAt)}) — rebuild below to catch it up.
                  </p>
                ) : null}
                {canRefineSilver ? (
                  <RefinePanel
                    datasetId={dataset.id} datasetName={dataset.name}
                    owner={dataset.owner} domain={dataset.domain} tier={dataset.tier}
                    columns={colNames}
                    silverBuilt={canHarmonizeGold}
                    proposal={cleanProposal}
                    stage={{ layer: 'silver', copy: { title: 'Clean it up', subtitle: '', tool: '' } }}
                    onCommitted={() => commitStageStay('define')}
                    onContinue={() => continueFrom('define')}
                  />
                ) : <p className="muted" style={{ fontSize: 13 }}>Bring in a Bronze layer first (in Ingest).</p>}
              </>
            ) : null}
          </div>
        ) : null}

        {/* ─────────────── Harmonize ─────────────── */}
        {stage.current === 'harmonize' ? (
          <div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Silver is clean — join and aggregate it into the Gold business mart, then explore the result.
            </p>
            {canEdit ? (
              <>
                <div className="section-title" style={{ marginTop: 0, alignItems: 'flex-start', flexWrap: 'wrap' }} {...anchorAttr(ANCHORS.data.harmonize)}>
                  Harmonize — Gold
                  <span className="hint" style={{ margin: '0 0 0 10px' }}>join trusted datasets into one governed Gold table</span>
                  {/* AI, built into the flow: propose the clean/join right where you build it. */}
                  <span style={{ marginLeft: 'auto' }}>
                    <AiAction
                      datasetId={dataset.id} stage="harmonize" cta="Propose a clean/join"
                      title="AI proposes how to clean and join this dataset into Gold"
                      payload={() => ({ name: dataset.name, columns: colNames })}
                    />
                  </span>
                </div>
                {staleVsBronze(dataset.versions, 'gold') ? (
                  <p className="hint" style={{ margin: '0 0 10px' }}>
                    Bronze has newer data than Gold ({fmtDate(dataset.versions.bronze.updatedAt)} vs {fmtDate(dataset.versions.gold.updatedAt)}) — rebuild below to catch it up.
                  </p>
                ) : null}
                <GoldJoinPanel
                  datasetId={dataset.id} datasetName={dataset.name}
                  owner={dataset.owner} domain={dataset.domain} tier={dataset.tier}
                  columns={colNames}
                  silverBuilt={canHarmonizeGold}
                  goldBuilt={dataset.versions.gold.built}
                  initialSpec={dataset.goldSpec}
                  onCommitted={() => commitStageStay('harmonize')}
                  onContinue={() => continueFrom('harmonize')}
                />
              </>
            ) : <p className="muted" style={{ fontSize: 13 }}>Only the owner and domain admins can harmonize this dataset.</p>}

            {builtLayers.length > 0 ? (
              <>
                <div className="section-title" style={{ marginTop: 22 }}>Explore</div>
                <ExplorePanel datasetId={dataset.id} builtLayers={builtLayers} showPreview={false} />
              </>
            ) : null}

            {/* See the result — the first 50 rows of the highest built layer (Gold if built). */}
            {rowPreviewBlock('Data preview', 'The first 50 rows of your highest built layer — Gold if built, otherwise Silver or Bronze — read through the governed Trino path.')}
          </div>
        ) : null}

        {/* ─────────────── Validate ─────────────── */}
        {stage.current === 'validate' ? (
          <div {...anchorAttr(ANCHORS.data.validate)}>
            {/* AI, built into the flow: one big action at the top — explain the profile's
                suggested checks, or (none yet) suggest which quality rules to author. */}
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
              <AiAction
                datasetId={dataset.id} stage="validate"
                cta={suggestions.length ? 'Explain suggested checks' : 'Suggest quality rules'}
                title={suggestions.length ? 'AI explains what each suggested check guards against' : 'AI suggests quality rules for the documented columns'}
                payload={() => ({
                  name: dataset.name,
                  columns: colNames,
                  // When we have deterministic profile→rule suggestions, hand them to the
                  // model as rendered lines so it explains WHY each matters (rationale layer).
                  ...(suggestions.length ? { suggestions: suggestions.map((s) => `${suggestionText(s)} — ${s.evidence}`) } : {}),
                })}
              />
            </div>
            {/* Health — one glanceable 0–100 + trend, computed from real runs (honest 'unknown'
                when nothing ran, never a fake 100). The exception (failing) is what shouts. */}
            <div className="guided-panel" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, color: health && health.score !== null ? (health.status === 'failing' ? 'var(--danger, #d64545)' : health.status === 'passing' ? 'var(--ok, #2e9e6b)' : 'inherit') : 'var(--muted, #999)' }}>
                  {health && health.score !== null ? health.score : '—'}
                </span>
                <span className="muted" style={{ fontSize: 13 }}>Health</span>
              </div>
              {trend.length >= 2 ? <Sparkline points={trend} /> : null}
              <div className="muted" style={{ fontSize: 13, display: 'flex', gap: 14, flexWrap: 'wrap', marginLeft: 'auto', alignItems: 'center' }}>
                {health ? (
                  <>
                    <span>✔ {health.passing} passing</span>
                    <span style={{ color: health.failing > 0 ? 'var(--danger, #d64545)' : undefined }}>✖ {health.failing} failing</span>
                    <span>• {health.notRun} not run</span>
                  </>
                ) : <span>Not run yet</span>}
                {ranAt ? <span title={`Last run ${formatDate(ranAt)}`}>⟳ {formatDate(ranAt)}</span> : null}
              </div>
            </div>

            {/* Suggested checks — deterministic from the profile, each citing its evidence.
                One-click Add, or Accept all. This is where "powerful" hides behind "simple". */}
            {suggestions.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div className="section-title" style={{ marginTop: 0 }}>
                  Suggested checks
                  <span className="count-pill">{suggestions.length}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>from the profile</span>
                  {canEdit ? (
                    <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={acceptAllSuggestions} disabled={acceptingAll || suggestBusy}>
                      {acceptingAll ? <span className="spin" /> : 'Accept all'}
                    </button>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {suggestions.map((s) => (
                    <div key={`${s.rule}:${s.column}`} className="guided-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{suggestionText(s)}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{s.evidence}</div>
                      </div>
                      {canEdit ? (
                        <button className="btn sm" onClick={() => acceptSuggestion(s)} disabled={suggestBusy || acceptingAll}>Add</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Quality checks — author rules + run them for real against the built table. */}
            <div className="section-title" style={{ marginTop: 0 }}>
              Your checks
              <span className="count-pill">{checks.length}</span>
              {badge ? (
                <span className={`badge ${badge === 'passing' ? 'vis-shared' : badge === 'failing' ? 'vis-personal' : ''}`} style={{ marginLeft: 10 }} title={ranAt ? `Last run ${formatDate(ranAt)}` : undefined}>
                  {badge === 'passing' ? '✓ passing' : badge === 'failing' ? '✗ failing' : 'not run'}
                </span>
              ) : null}
              {checks.length > 0 ? (
                <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={runChecks} disabled={running}>
                  {running ? <span className="spin" /> : 'Run checks'}
                </button>
              ) : null}
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Author the rules this dataset must meet, then run them against the built table — a real pass/fail per rule through the governed query path. Nothing runs until a layer is materialized.
            </p>
            {runErr ? <div className="error" style={{ marginBottom: 10 }}>{runErr}</div> : null}
            {checks.length > 0 ? (
              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table>
                  <thead><tr><th>Rule</th><th>Added by</th><th>Result</th>{canEdit ? <th /> : null}</tr></thead>
                  <tbody>
                    {checks.map((chk) => {
                      const r = results[chk.id];
                      const failing = r?.status === 'fail';
                      return (
                        <Fragment key={chk.id}>
                          <tr>
                            <td className="mono" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{ruleText(chk)}</td>
                            <td className="muted">{chk.createdBy}</td>
                            <td>
                              {r ? (
                                r.status === 'pass' ? <span className="status-chip s-searchable" style={{ cursor: 'default' }}>✓ pass</span>
                                  : r.status === 'fail' ? <span className="status-chip s-stored" style={{ cursor: 'default' }} title={`${r.violations} violating row(s)`}>✗ fail · {r.violations}</span>
                                    : <span className="muted" title={r.reason}>not run</span>
                              ) : <span className="muted">—</span>}
                              {failing ? (
                                <button
                                  className="btn ghost sm"
                                  style={{ marginLeft: 8 }}
                                  aria-expanded={fixOpen === chk.id}
                                  onClick={() => setFixOpen((open) => (open === chk.id ? null : chk.id))}
                                >
                                  {fixOpen === chk.id ? 'Hide fixes' : 'Fix…'}
                                </button>
                              ) : null}
                            </td>
                            {canEdit ? <td><button className="btn ghost sm" onClick={() => deleteRule(chk.id)} aria-label="Remove rule">×</button></td> : null}
                          </tr>
                          {failing && fixOpen === chk.id ? (
                            <tr>
                              <td colSpan={canEdit ? 4 : 3} style={{ background: 'var(--panel)', paddingTop: 0 }}>
                                {/* AI-proposed remediations — propose (read + advice) then an explicit,
                                    edit-gated apply; the rule is RE-RUN after apply and the fresh verdict
                                    replaces this row's chip (a fix that didn't fix stays red). */}
                                <QualityFixPanel
                                  datasetId={dataset.id}
                                  checkId={chk.id}
                                  column={chk.column ?? ''}
                                  canEdit={canEdit}
                                  onApplied={(recheck) => {
                                    setResults((m) => ({ ...m, [chk.id]: recheck as CheckResult }));
                                    void loadDq(); // refresh the persisted trend after a real change
                                  }}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>No quality rules yet — add one below.</p>}

            {canEdit ? (
              <div className="guided-panel" style={{ padding: '12px 16px' }}>
                <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Add a rule</div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as DataCheckRule)} style={{ maxWidth: 170 }}>
                    {(Object.keys(RULE_LABELS) as DataCheckRule[]).map((k) => <option key={k} value={k}>{RULE_LABELS[k]}</option>)}
                  </select>
                  {dataset.columns.length > 0 ? (
                    <select value={ruleColumn} onChange={(e) => setRuleColumn(e.target.value)} style={{ maxWidth: 200 }}>
                      <option value="">column…</option>
                      {dataset.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  ) : <input style={{ maxWidth: 200 }} placeholder="column" value={ruleColumn} onChange={(e) => setRuleColumn(e.target.value)} />}
                  {ruleKind === 'accepted_values' ? <input style={{ flex: 1, minWidth: 160 }} placeholder="allowed values, comma-separated" value={ruleValues} onChange={(e) => setRuleValues(e.target.value)} /> : null}
                  {ruleKind === 'range' ? (
                    <>
                      <input style={{ maxWidth: 90 }} placeholder="min" value={ruleMin} onChange={(e) => setRuleMin(e.target.value)} inputMode="decimal" />
                      <input style={{ maxWidth: 90 }} placeholder="max" value={ruleMax} onChange={(e) => setRuleMax(e.target.value)} inputMode="decimal" />
                    </>
                  ) : null}
                  <button className="btn" onClick={addRule} disabled={checksBusy || !ruleColumn.trim()}>
                    {checksBusy ? <span className="spin" /> : 'Add rule'}
                  </button>
                </div>
                {checksErr ? <div className="error" style={{ marginTop: 8 }}>{checksErr}</div> : null}
              </div>
            ) : null}

            {/* Auto-monitors — heuristic freshness/volume/schema, on by default. Monte-Carlo's
                lesson: coverage without writing rules. Each is explainable (mean±kσ / cadence /
                column-set), contributes to the health score, and honours the honesty contract
                (too little history ⇒ "not run", never a fake pass). */}
            {monitors.length > 0 ? (
              <>
                <div className="section-title" style={{ marginTop: 20 }}>
                  Auto-monitors
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>on by default</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {monitors.map((m) => (
                    <div key={m.kind} className="guided-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{MONITOR_LABELS[m.kind].label}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{MONITOR_LABELS[m.kind].hint}</div>
                      </div>
                      {canEdit ? (
                        <button
                          className={`btn ghost sm ${m.enabled ? '' : 'off'}`}
                          onClick={() => toggleMonitor(m.kind, !m.enabled)}
                          disabled={monitorBusy === m.kind}
                          aria-pressed={m.enabled}
                        >
                          {monitorBusy === m.kind ? <span className="spin" /> : m.enabled ? 'On' : 'Off'}
                        </button>
                      ) : (
                        <span className="muted" style={{ fontSize: 12.5 }}>{m.enabled ? 'On' : 'Off'}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {/* Lineage — refinement + consumption chain, moved here from the old Use stage. */}
            <div className="section-title" style={{ marginTop: 24 }}>Lineage</div>
            <LineagePanel datasetId={dataset.id} />

            {/* The rows the checks ran against — same governed preview as every other stage. */}
            {rowPreviewBlock('Data preview', 'The first 50 rows the quality checks run against — read through the governed Trino path.')}
          </div>
        ) : null}

        {/* ─────────────── Publish (Metrics & Usage) ─────────────── */}
        {stage.current === 'publish' ? (
          <div>
            {/* AI, built into the flow: one big action at the top — suggest the governed
                measures worth defining before promoting/certifying. */}
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
              <AiAction
                datasetId={dataset.id} stage="publish" cta="Suggest measures"
                title="AI suggests governed measures to define before you promote"
                payload={() => ({ name: dataset.name, columns: colNames, measures: dataset.measures.map((m) => m.name) })}
              />
            </div>
            {/* Sharing / promotion — the governed promote/certify block (moved to the top:
                deciding who sees this dataset comes before building on it). Logic unchanged. */}
            <div className="section-title" style={{ marginTop: 0 }} {...anchorAttr(ANCHORS.data.publish)}>Sharing</div>
            {dataset.tier === 'dataset' ? (
              canHarmonizeGold ? (
                <div className="gate-check" style={{ marginTop: 4 }}>
                  <span className="badge vis-personal">Personal</span>{' '}
                  {promote?.request?.status === 'pending' ? (
                    <span className="muted" style={{ fontSize: 13 }}>
                      Promotion requested — a domain <strong>Builder</strong> approves it in the <strong>Governance</strong> tab, which moves it into Trino.
                    </span>
                  ) : canEdit ? (
                    <>
                      <span className="muted" style={{ fontSize: 13 }}>In your private space — only you can see it. Promote it to share with your domain.</span>
                      {promote && !promote.gate.ok ? <div className="hint" style={{ margin: '6px 0 0' }}>To share, add {promote.gate.missing.join(', ')}.</div> : null}
                      <div className="row" style={{ marginTop: 8 }}>
                        <button className="btn" disabled={shareBusy || !!(promote && !promote.gate.ok)} onClick={requestPromote}
                          title={promote && !promote.gate.ok ? 'Complete the transparency gate first' : 'A domain Builder approves this and moves it into Trino'}>
                          {shareBusy ? <span className="spin" /> : 'Promote to Domain →'}
                        </button>
                      </div>
                    </>
                  ) : <span className="muted" style={{ fontSize: 13 }}>Private to {dataset.owner}.</span>}
                </div>
              ) : (
                <div className="gate-check" style={{ marginTop: 4 }}>
                  <span className="badge vis-personal">Personal</span>{' '}
                  <span className="muted" style={{ fontSize: 13 }}>
                    This raw <strong>Bronze</strong> dataset can&apos;t be shared yet — <strong>promote after refining to Silver/Gold</strong>.
                    {canEdit ? <> Refine it in the <strong>Define</strong> or <strong>Harmonize</strong> stage first.</> : null}
                  </span>
                </div>
              )
            ) : dataset.tier === 'asset' ? (
              <div className="gate-check gate-ok" style={{ marginTop: 4 }}>
                <span className="badge vis-shared">Domain</span>{' '}
                <span className="muted" style={{ fontSize: 13 }}>Promoted data asset in <strong>Trino/Iceberg</strong> ({dataset.domain} domain).</span>
                {certifyPending ? (
                  <div className="hint" style={{ marginTop: 6 }}>Certification requested — a platform <strong>Admin</strong> approves it in the <strong>Governance</strong> tab.</div>
                ) : (
                  <div className="row" style={{ marginTop: 8 }}>
                    {isAdmin ? (
                      <button className="btn" disabled={shareBusy} onClick={() => certifyAsset('certify')} title="Certify this asset as a data product and list it in the marketplace">
                        {shareBusy ? <span className="spin" /> : 'Certify to Company →'}
                      </button>
                    ) : canEdit ? (
                      <button className="btn ghost" disabled={shareBusy} onClick={() => certifyAsset('request')} title="Ask a platform Admin to certify this as a marketplace data product">
                        {shareBusy ? <span className="spin" /> : 'Request certification →'}
                      </button>
                    ) : <span className="muted" style={{ fontSize: 13 }}>An Admin certifies it as a marketplace data product.</span>}
                  </div>
                )}
              </div>
            ) : dataset.tier === 'product' ? (
              <div className="gate-check gate-ok" style={{ marginTop: 4 }}>
                <span className="badge vis-certified">Company</span>{' '}
                <span className="muted" style={{ fontSize: 13 }}>Certified data product — discoverable across the marketplace.</span>
              </div>
            ) : null}
            {shareErr ? <div className="error" style={{ marginTop: 8 }}>{shareErr}</div> : null}

            {/* Preview what you're publishing — the same governed 50-row view as every stage. */}
            {rowPreviewBlock('Data preview', 'The first 50 rows of what you are publishing — read through the governed Trino path, under your own row security.')}

            {/* Talk to Data — governed NL→SQL over what the viewer can see (usage before promote). */}
            <div {...anchorAttr(ANCHORS.data.query)} style={{ marginTop: 24 }}>
              <TalkTo tab="data" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
            </div>

            {/* Build on this data — the metrics, dashboards and agent systems already connected
                to this dataset, each linking out + offering an inline create pre-scoped to it. */}
            <ConnectedBuild datasetId={dataset.id} />

            {/* Configuration drawer (dbt SQL / dataset.yaml) — the technical surface, kept last. */}
            {canEdit ? (
              <>
                <div className="section-title" style={{ marginTop: 24 }}>
                  Configuration
                  <button className={`btn ghost sm${showCode ? ' on' : ''}`} style={{ marginLeft: 10 }} onClick={() => setShowCode((v) => !v)}>
                    {showCode ? 'Hide the code' : '‹ › Show the code'}
                  </button>
                </div>
                {showCode ? (
                  <div style={{ marginBottom: 14 }}>
                    <p className="hint" style={{ marginTop: 0 }}>dataset.yaml is the single source — the panels and the data agent all read and write these files.</p>
                    <CodeDrawer datasetId={dataset.id} />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </StageShell>
      ) : (
        <DataDeveloperView dataset={dataset} datasetId={datasetId} />
      )}
    </ConfirmProvider>
  );
}

/* ─────────────────────────── Developer surface ─────────────────────────── */

/**
 * The Data Developer view — the raw technical surface of this dataset. Shows:
 *   1. Medallion layer FQNs (bronze/silver/gold physical tables) — from the live
 *      dataset state, same derivation as physicalFqn() above.
 *   2. The dbt SQL artifact(s) — fetched from the existing files endpoint (the SAME
 *      source CodeDrawer uses in Publish; no new endpoint).
 *   3. The Cube model YAML — fetched from the cluster-internal /api/cube/models
 *      endpoint which builds it from the SAME registry the builder holds.
 *   4. Governance/RLS summary — tier, visibility, domain, certification status.
 *
 * Read-only with a clear label. If a piece isn't available yet, an honest
 * placeholder is shown rather than fabricated content.
 */
function DataDeveloperView({ dataset, datasetId }: { dataset: Dataset; datasetId: string }) {
  /* ── dbt SQL artifacts (silver + gold) from the files endpoint ── */
  const [sqlFiles, setSqlFiles] = useState<{ path: string; content: string }[]>([]);
  const [sqlErr, setSqlErr] = useState('');
  useEffect(() => {
    (async () => {
      setSqlErr('');
      try {
        const listRes = await fetch(`/api/data/datasets/${datasetId}/files`, { cache: 'no-store' });
        if (!listRes.ok) return;
        const { files } = (await listRes.json()) as { files: string[] };
        const sqlPaths = (files ?? []).filter((f: string) => f.endsWith('.sql'));
        const loaded = await Promise.all(
          sqlPaths.map(async (p: string) => {
            const r = await fetch(`/api/data/datasets/${datasetId}/files?path=${encodeURIComponent(p)}`, { cache: 'no-store' });
            if (!r.ok) return null;
            const d = (await r.json()) as { content?: string };
            return { path: p, content: d.content ?? '' };
          })
        );
        setSqlFiles(loaded.filter((x): x is { path: string; content: string } => x !== null));
      } catch (e) {
        setSqlErr((e as Error).message);
      }
    })();
  }, [datasetId]);

  /* ── Cube model YAML — from /api/cube/models, filtered to this dataset ── */
  const [cubeYaml, setCubeYaml] = useState<string | null>(null);
  const [cubeErr, setCubeErr] = useState('');
  useEffect(() => {
    if (!isCubeReady(dataset)) return; // only worth fetching if Gold + governed
    (async () => {
      setCubeErr('');
      try {
        const res = await fetch('/api/cube/models', { cache: 'no-store' });
        if (!res.ok) { setCubeErr('Cube model endpoint unavailable'); return; }
        type CubeEntry = { name: string; file: string; model: string };
        const data = (await res.json()) as { models: CubeEntry[] };
        const dsSlug = dataset.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
        const hit = (data.models ?? []).find(
          (m: CubeEntry) => m.name === dsSlug || m.name.endsWith(`__${dsSlug}`) ||
            m.file.includes(dsSlug)
        );
        setCubeYaml(hit?.model ?? null);
      } catch (e) {
        setCubeErr((e as Error).message);
      }
    })();
  }, [dataset]);

  const builtLayers = (['bronze', 'silver', 'gold'] as Layer[]).filter((l) => dataset.versions[l].built);
  const cubeReady = isCubeReady(dataset);

  return (
    <div style={{ marginTop: 4 }}>
      {/* 1 ── Medallion FQNs */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">Medallion layer FQNs</div>
        <p className="hint" style={{ marginTop: 4 }}>
          Read-only — the physical Iceberg tables this dataset materialises in Trino.
          Each FQN is the single address the query engine, Cube and OPA all use.
        </p>
        {builtLayers.length > 0 ? (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {builtLayers.map((l) => {
              const fqn = physicalFqn(dataset, l);
              const art = dataset.versions[l].artifact;
              return (
                <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span className="chip" style={{ textTransform: 'capitalize', minWidth: 56 }}>{l}</span>
                  <code className="mono" style={{ fontSize: 11, flex: 1, wordBreak: 'break-all' }}>{fqn}</code>
                  {art ? <span className="muted" style={{ fontSize: 11 }}>→ {art}</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            No layer built yet — Ingest a file in the Simple flow to materialise Bronze.
          </p>
        )}
      </div>

      {/* 2 ── dbt SQL artifacts */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">dbt SQL artifacts</div>
        <p className="hint" style={{ marginTop: 4 }}>
          Read-only — the generated dbt model SQL files. These are the same files
          the &ldquo;Show the code&rdquo; drawer in Publish exposes; authored here for
          inspection without switching mode.
        </p>
        {sqlErr ? <div className="error" style={{ marginTop: 8 }}>{sqlErr}</div> : null}
        {sqlFiles.length > 0 ? (
          sqlFiles.map(({ path, content }) => (
            <div key={path} style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{path}</div>
              <pre className="codeblock" style={{ fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>
                {content || '(empty)'}
              </pre>
            </div>
          ))
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            {sqlErr ? null : 'No dbt SQL files yet — refine to Silver or harmonize to Gold in the Simple flow to generate them.'}
          </p>
        )}
      </div>

      {/* 3 ── Cube model YAML */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">Cube model YAML</div>
        <p className="hint" style={{ marginTop: 4 }}>
          Read-only — the generated Cube.js model delivered to the semantic layer.
          Available only when Gold is built and the dataset is a governed asset or product.
        </p>
        {cubeErr ? <div className="error" style={{ marginTop: 8 }}>{cubeErr}</div> : null}
        {cubeReady && cubeYaml ? (
          <pre className="codeblock" style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            {cubeYaml}
          </pre>
        ) : cubeReady && !cubeErr ? (
          <p className="hint" style={{ marginTop: 8 }}>
            Cube model pending — the sidecar will sync it once the Gold build is picked up.
            Reload to check.
          </p>
        ) : !cubeReady ? (
          <p className="hint" style={{ marginTop: 8 }}>
            Not available: {dataset.tier === 'dataset' ? 'promote this dataset to a governed asset first, then build Gold.' : 'build the Gold layer first (in Harmonize).'}
          </p>
        ) : null}
      </div>

      {/* 4 ── Governance / RLS summary */}
      <div className="grant-block">
        <div className="comp-label">Governance &amp; RLS summary</div>
        <p className="hint" style={{ marginTop: 4 }}>
          Read-only — the tier, visibility, ownership and certification that OPA enforces
          on every query through Trino and Cube.
        </p>
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13 }}>
          <span className="muted">Tier</span>
          <span><span className={`badge ${TIER_BADGE[dataset.tier]}`}>{TIER_WORD[dataset.tier]}</span></span>
          <span className="muted">Visibility</span>
          <span>{VIS_WORD[dataset.visibility] ?? dataset.visibility}</span>
          <span className="muted">Owner</span>
          <span className="mono" style={{ fontSize: 12 }}>{dataset.owner}</span>
          <span className="muted">Domain</span>
          <span>{dataset.domain}</span>
          <span className="muted">Cube-ready</span>
          <span>{cubeReady ? <span className="status-chip s-searchable" style={{ cursor: 'default' }}>✓ yes</span> : <span className="status-chip s-stored" style={{ cursor: 'default' }}>no</span>}</span>
          {dataset.certification ? (
            <>
              <span className="muted">Certified</span>
              <span><span className={`badge cert-${dataset.certification.level}`}>{dataset.certification.level}</span>{' by '}{dataset.certification.by}{' on '}{formatDate(dataset.certification.at)}</span>
            </>
          ) : null}
          {dataset.columns.length > 0 ? (
            <>
              <span className="muted">Columns</span>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-word' }}>
                {dataset.columns.map((c) => c.name).filter(Boolean).join(' · ') || '—'}
              </span>
            </>
          ) : null}
          {dataset.measures.length > 0 ? (
            <>
              <span className="muted">Measures</span>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-word' }}>
                {dataset.measures.map((m) => m.name).join(' · ')}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
