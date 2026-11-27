/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { useTranslations, useFormat } from '@core/i18n/client';
import type { Formatters } from '@core/i18n/format';
import { canManageArtifact } from '@core/policy/edit-scope';
import { roleAtLeast } from '@core/kernel/session';
import LineagePanel from '@tabs/data/ui/LineagePanel';
import RefinePanel from '@tabs/data/ui/RefinePanel';
import GoldJoinPanel from '@tabs/data/ui/GoldJoinPanel';
import ExplorePanel from '@tabs/data/ui/ExplorePanel';
import BronzePanel from '@tabs/data/ui/BronzePanel';
import SyncPanel from '@tabs/data/ui/SyncPanel';
import ConnectedSourcePanel from '@tabs/data/ui/ConnectedSourcePanel';
import QualityFixPanel from '@tabs/data/ui/QualityFixPanel';
import BuildResultDialog, { type BuildResult } from '@tabs/data/ui/BuildResultDialog';
import QueryError from '@tabs/data/ui/QueryError';
import { shouldAutoGold } from '@tabs/data/lib/auto-gold';
import AiAction, { type CleanDraft, type DefineDraft } from '@tabs/data/ui/StageAssistant';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import DatasetVersions from '@tabs/data/ui/DatasetVersions';
import DemoteButton from '@core/ui/lifecycle/DemoteButton';
import { ConfirmProvider } from '@core/ui/lifecycle/ConfirmDialog';
import { useApprovalNotifier } from '@core/ui/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@core/policy/approval-notice';
import DomainTag from '@core/ui/DomainTag';
import type { Visibility } from '@core/kernel/lifecycle';
import { usePublishPageContext } from '@core/ui/core/PageContext';
import { type DataCtx } from '@tabs/data/lib/stages';
import BuilderModeToggle from '@core/ui/core/BuilderModeToggle';
import type { ViewMode } from '@core/kernel/view-mode';
import { TIER_BADGE_CLASS } from '@core/kernel/scopes';
import type { GoldSpec } from '@tabs/data/lib/dataset-schema';

const DATA_MODE_KEY = 'data.viewMode';

type Layer = 'bronze' | 'silver' | 'gold';
type VersionState = { built: boolean; updatedAt: string | null; artifact: string | null };
type ColumnDoc = { name: string; description: string; personalData?: boolean };
type DataCheckRule = 'not_null' | 'not_blank' | 'unique' | 'accepted_values' | 'range' | 'reference';
type DataCheck = {
  id: string; name: string; description: string; createdBy: string; createdAt: string;
  rule?: DataCheckRule; column?: string; values?: string[]; min?: number; max?: number;
  toDataset?: string; toColumn?: string;
};
type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_run';
type CheckResult = { id: string; label: string; status: CheckStatus; violations: number | null; reason?: string };
import { dqSourceKeys } from '@tabs/data/lib/dq';

type QualityBadge = 'passing' | 'failing' | 'unknown';
/** Health score payload — mirrors HealthScore from lib/data/dq. */
type HealthScore = { score: number | null; status: QualityBadge; passing: number; failing: number; notRun: number };
/** One persisted run's health point — mirrors healthTrend from lib/data/dq-results. */
type TrendPoint = { ranAt: string; score: number | null; badge: QualityBadge };
/** A deterministic profile→rule proposal — mirrors SuggestedCheck from lib/data/dq-suggest.
 *  `description` is the deterministic plain-language sentence that lands on the check when accepted. */
type SuggestedCheck = { rule: DataCheckRule; column: string; values?: string[]; min?: number; max?: number; evidence: string; description?: string };
/** A heuristic-monitor toggle — mirrors MonitorKind from lib/data/dq-monitors. */
type MonitorKind = 'freshness' | 'volume' | 'schema';
type MonitorToggle = { kind: MonitorKind; enabled: boolean };
/** The `data` namespace translator, passed to this file's pure helpers. */
type T = ReturnType<typeof useTranslations<'data'>>;
const MONITOR_KEYS = {
  freshness: { label: 'builder.monitors.freshness.label', hint: 'builder.monitors.freshness.hint' },
  volume: { label: 'builder.monitors.volume.label', hint: 'builder.monitors.volume.hint' },
  schema: { label: 'builder.monitors.schema.label', hint: 'builder.monitors.schema.hint' },
} as const satisfies Record<MonitorKind, { label: string; hint: string }>;
type Certification = { level: string; by: string; at: string };
/** Promotion gate + in-flight request — mirrors the promote route's GET payload. */
type Gate = { ok: boolean; missing: string[] };
type PromoteStatus = { tier: Dataset['tier']; gate: Gate; request: { status: string; detail?: string } | null };
/** Governed row-preview outcome — mirrors PreviewOutcome from lib/data/preview. */
type RowPreview =
  | { available: true; layer: string; fqn: string; limit: number; columns: string[]; rows: string[][]; rowCount: number }
  | { available: false; layer?: string; fqn?: string; reason: string };

// The rule matrix (labels, which extra fields a rule needs, the add payload, the stored label)
// lives in `lib/dq-rule-form.ts` so it can be unit-tested — a test may not import a `.tsx`.
import { RULE_LABELS, RULE_LABEL_KEYS, fieldsFor, addPayload, canSubmit as canSubmitRule, ruleText } from '@tabs/data/lib/dq-rule-form';
import { UnderTheHood } from '@core/ui/engineering/UnderTheHood';
import { TechnicalDetailsOnly } from '@core/ui/TechnicalDetails';
import GitHeadBadge from '@core/ui/git/GitHeadBadge';
import CloneRepository from '@core/ui/git-clone/CloneRepository';
import { PersonalDataSelect, PersonalDataCertifyCheck, withPersonalData, type PersonalDataStatus, type PersonalDataRefusal, type PersonalDataConfirm } from '@tabs/data/ui/PersonalDataCertify';
const RULE_KINDS = new Set<DataCheckRule>(Object.keys(RULE_LABELS) as DataCheckRule[]);

/** A human, exception-first label for a suggested check (Apple-simple, no jargon). */
function suggestionText(s: SuggestedCheck, t: T): string {
  const column = s.column;
  switch (s.rule) {
    case 'not_null': return t('builder.suggestion.notNull', { column });
    case 'not_blank': return t('builder.suggestion.notBlank', { column });
    case 'unique': return t('builder.suggestion.unique', { column });
    case 'accepted_values': return t('builder.suggestion.acceptedValues', { column, values: `{${(s.values ?? []).join(', ')}}` });
    case 'range': return t('builder.suggestion.range', { column, min: String(s.min ?? '−∞'), max: String(s.max ?? '∞') });
    case 'reference': return t('builder.suggestion.reference', { column });
    default: return s.column;
  }
}

/** Turn the dq route's machine `reason` (no built layer / layer not queryable / profile
 *  failed) into ONE calm sentence. Curated datasets compose straight to Gold with no
 *  bronze/silver fallback, so "build the dataset first" is the honest, common cause. */
function profileReasonText(reason: string, t: T): string {
  switch (reason) {
    case 'no built layer':
    case 'layer not queryable':
      return t('builder.profileReason.unbuilt');
    default:
      return t('builder.profileReason.failed');
  }
}

/**
 * A tiny inline health-trend sparkline over the persisted runs. Pure SVG, no deps. A run
 * that measured nothing (score null) is drawn as a gap, never a fake 0 — the honesty
 * contract, visualised. Colour tracks the latest badge.
 */
function Sparkline({ points }: { points: TrendPoint[] }) {
  const t = useTranslations('data');
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
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t('builder.sparklineAria')} style={{ display: 'block' }}>
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}

type Dataset = {
  id: string;
  name: string;
  /** The FROZEN physical slug (present once a rename decoupled it from the name). */
  slug?: string;
  laneSlug?: string;
  owner: string;
  domain: string;
  tier: 'dataset' | 'asset' | 'product';
  /** How the dataset was born — 'curated' walks Compose·Document·Validate·View;
   *  'connected' is an adopted external table (Source stage, no Ingest/Refine). */
  origin?: 'ingest' | 'curated' | 'connected';
  /** ADOPTED-FROM-A-CONNECTION block (present only with origin:'connected'). */
  connected?: {
    connectionId: string;
    exposureId: string;
    source: { catalog: string; schema: string; table: string };
    mode: 'live' | 'sync';
    tier: 'silver' | 'gold';
    status: 'ok' | 'drifted' | 'source-revoked';
  };
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
  /** #96: the governed DOMAIN gold table has drifted (missing/stale) — the detail route
   *  probes it physically, so this is honest even when the stored flag was never set. */
  domainTableStale?: boolean;
  /** 'ai-auto' when the documentation was AUTO-DRAFTED after ingestion and not yet reviewed
   *  by a human — drives the subtle "AI-drafted — review…" note. Cleared on a human save. */
  docsProvenance?: 'ai-auto';
};

/** Tile tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: Dataset['tier']): Visibility =>
  tier === 'asset' ? 'shared' : tier === 'product' ? 'certified' : 'personal';

/** Inline slug — mirrors store-fqn.ts without importing server code. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

function fmtDate(iso: string | null, f: Formatters): string {
  if (!iso) return '—';
  return f.dateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }) || iso;
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
  // A personal dataset's lane table carries its recorded lane name (unique per dataset).
  if (d.tier === 'dataset') return `iceberg.personal_${slug(d.owner)}.${layer}_${d.laneSlug ?? physicalSlug(d)}`;
  return `iceberg.${slug(d.domain)}.${layer}_${physicalSlug(d)}`;
}

/** Whether a dataset's governed metric model can be served (mirrors metricDeliverable). */
function isMetricReady(d: Dataset): boolean {
  return d.tier !== 'dataset' && d.versions.gold.built;
}

function formatDate(iso: string, f: Formatters): string {
  return f.date(iso, { year: 'numeric', month: 'short', day: 'numeric' }) || iso;
}

const TIER_BADGE: Record<Dataset['tier'], string> = { dataset: TIER_BADGE_CLASS.personal, asset: TIER_BADGE_CLASS.shared, product: TIER_BADGE_CLASS.certified };
const TIER_WORD = { dataset: 'builder.tier.dataset', asset: 'builder.tier.asset', product: 'builder.tier.product' } as const satisfies Record<Dataset['tier'], string>;
// Display words for a dataset's stored visibility. Core (lib/core/scopes.ts) is the
// source of truth for scope vocabulary; these lowercase keys are this tab's own field
// values, mirrored to the same nouns ("Shared"→"Domain").
const VIS_WORD: Record<string, 'builder.vis.private' | 'builder.vis.domain' | 'builder.vis.public'> = { private: 'builder.vis.private', domain: 'builder.vis.domain', shared: 'builder.vis.domain', public: 'builder.vis.public' };
/** The visibility word for a stored value — translated when known, the raw value otherwise. */
const visWord = (v: string, t: T): string => (VIS_WORD[v] ? t(VIS_WORD[v]) : v);
/** A medallion layer name in the reader's language — the raw value when it is not a known layer. */
const layerWord = (l: string, t: T): string => (l === 'bronze' || l === 'silver' || l === 'gold' ? t(`builder.layer.${l}`) : l);

/** "Show the code" — the same versioned files the panels + agent edit. */
function CodeDrawer({ datasetId }: { datasetId: string }) {
  const t = useTranslations('data');
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
      if (!res.ok) { setErr(data.error ?? t('builder.code.readFailed')); return; }
      setPath(p); setContent(data.content); setSha(data.sha);
    } catch (e) { setErr((e as Error).message); }
  }, [datasetId, t]);

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
      if (!res.ok) { setErr(data.error ?? t('builder.code.saveFailed')); return; }
      setSha(data.sha); setSavedNote(t('builder.code.saved'));
    } catch (e) { setErr((e as Error).message); }
  }, [datasetId, path, content, sha, t]);

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
          {editable ? t('builder.code.editableHint') : t('builder.code.nativeHint')}
          {savedNote ? <span className="ok-note"> {savedNote}</span> : null}
        </div>
        {editable ? <button className="btn" onClick={save}>{t('builder.code.save')}</button> : null}
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
  const t = useTranslations('data');
  const metrics = useConnected<MetricRow>(datasetId, 'metrics', (b) => (b as { metrics?: MetricRow[] }).metrics ?? []);
  const dashboards = useConnected<DashboardRow>(datasetId, 'dashboards', (b) => (b as { dashboards?: DashboardRow[] }).dashboards ?? []);
  const systems = useConnected<SystemRow>(datasetId, 'agents', (b) => (b as { systems?: SystemRow[] }).systems ?? []);

  return (
    <>
      {/* Metrics defined on this dataset. */}
      <div className="section-title" style={{ marginTop: 24 }}>
        {t('builder.connected.metrics')}
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
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{t('builder.connected.noMetrics')}</p>
      ) : null}
      <div className="row" style={{ marginBottom: 4 }}>
        <a className="btn ghost sm" href={`/metrics?new=1&dataset=${encodeURIComponent(datasetId)}`} title={t('builder.connected.newMetricTitle')}>
          {t('builder.connected.newMetric')}
        </a>
      </div>

      {/* Dashboards bound to this dataset's governed view. */}
      <div className="section-title" style={{ marginTop: 20 }}>
        {t('builder.connected.dashboards')}
        {dashboards.rows.length > 0 ? <span className="count-pill">{dashboards.rows.length}</span> : null}
      </div>
      {dashboards.rows.length > 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {dashboards.rows.map((d) => (
            <a className="chip" key={d.id} href={`/dashboards?focus=${encodeURIComponent(d.id)}`} style={{ textDecoration: 'none' }}>{t('builder.connected.dashboardChip', { name: d.name, count: d.charts })}</a>
          ))}
        </div>
      ) : dashboards.loaded ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{t('builder.connected.noDashboards')}</p>
      ) : null}
      <div className="row" style={{ marginBottom: 4 }}>
        <a className="btn ghost sm" href={`/dashboards?new=1&dataset=${encodeURIComponent(datasetId)}`} title={t('builder.connected.newDashboardTitle')}>
          {t('builder.connected.newDashboard')}
        </a>
      </div>

      {/* Agent systems that consume this dataset. */}
      <div className="section-title" style={{ marginTop: 20 }}>
        {t('builder.connected.systems')}
        {systems.rows.length > 0 ? <span className="count-pill">{systems.rows.length}</span> : null}
      </div>
      {systems.rows.length > 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {systems.rows.map((s) => (
            <a className="chip" key={s.id} href={`/agents?system=${encodeURIComponent(s.id)}`} style={{ textDecoration: 'none' }}>{t('builder.connected.systemChip', { name: s.name, count: s.agentCount })}</a>
          ))}
        </div>
      ) : systems.loaded ? (
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{t('builder.connected.noSystems')}</p>
      ) : null}
      <div className="row" style={{ marginBottom: 4 }}>
        <a className="btn ghost sm" href="/agents?system=new" title={t('builder.connected.newSystemTitle')}>
          {t('builder.connected.newSystem')}
        </a>
      </div>
    </>
  );
}

/**
 * The Data builder — a plain View⇄Edit surface (the OS-wide contract, mirroring
 * MetricBuilder/DashboardBuilder). The staged StageShell walk retired (0.6.44): the same
 * bodies (BronzePanel, RefinePanel, GoldJoinPanel, docs + quality editor, ExplorePanel,
 * LineagePanel, the DQ dashboard) are re-hosted UNCHANGED as flat Edit/View
 * sections rather than behind a stepper.
 *
 *   VIEW (tile click lands here) — Talk to Data · statistics · layer-named preview · the
 *     data-quality dashboard. The calm home to USE the data.
 *   EDIT — origin-shaped:
 *     · INGESTED — the full journey in one surface: ingest source → clean/conform into
 *       Silver → bring to Gold as a SINGLE-TABLE projection (keep/rename + derived fields)
 *       → quality rules. Combining datasets is NOT here — that's a curated capability
 *       (the "Join to" section is hidden unless a stored spec has legacy joins).
 *     · CURATED — no ingestion, no Silver tooling: pick the EXPLICIT base + join in other
 *       datasets → columns + derived fields → document → quality rules.
 *
 * A fresh dataset (nothing materialized) opens in Edit; a materialized one opens in View.
 * View⇄Edit + Promote + lifecycle live in the detail header. Legacy grandfathering: any
 * dataset whose stored goldSpec has joins keeps the join editor visible regardless of origin.
 */
export default function DataBuilder({
  datasetId,
  onBack,
}: {
  datasetId: string;
  onBack: () => void;
}) {
  const t = useTranslations('data');
  const f = useFormat();
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


  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [checks, setChecks] = useState<DataCheck[]>([]);
  const [loadErr, setLoadErr] = useState('');

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
  // `reference`: the dataset + column every value of the chosen column must exist in.
  const [ruleToDataset, setRuleToDataset] = useState('');
  const [ruleToColumn, setRuleToColumn] = useState('');
  const [checksBusy, setChecksBusy] = useState(false);
  const [checksErr, setChecksErr] = useState('');
  // In-progress plain-language descriptions per check id — the editable text (typed or
  // AI-drafted) before "Save Data Quality Checks" persists them. Seeded from the loaded
  // checks so an existing description shows for editing; a missing key falls back to the
  // check's stored description at render time.
  const [descDrafts, setDescDrafts] = useState<Record<string, string>>({});
  // Confirming note for the Checks section's primary "Save Data Quality Checks" action —
  // rules + monitor toggles already persist on edit through their governed routes, so this
  // flushes any half-filled rule in the editor and confirms the saved state honestly.
  const [checksSavedNote, setChecksSavedNote] = useState('');
  // ---- run results ----
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [badge, setBadge] = useState<QualityBadge | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState('');
  // DQ-dashboard counters (View stage): how the authored checks split on their latest
  // run this session. `results` fills on runChecks; unrun checks stay honest dots.
  const dqRan = checks.filter((c) => results[c.id]).length;
  const dqPassing = checks.filter((c) => results[c.id]?.status === 'pass').length;
  const dqFailing = checks.filter((c) => results[c.id]?.status === 'fail').length;
  // ---- AI-proposed remediations: which failing rule's fix panel is open ----
  const [fixOpen, setFixOpen] = useState<string | null>(null);
  // ---- health score + persisted trend + profile-driven suggestions (Validate) ----
  const [health, setHealth] = useState<HealthScore | null>(null);
  // WHO produced the last verdict: a dbt test Dagster ran, or the OS's own ad-hoc probe
  // (review B2-review-M5). Null when the record predates the distinction.
  const [dqSource, setDqSource] = useState<'dagster' | 'os' | undefined>(undefined);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedCheck[]>([]);
  // Why the profile produced no suggestions, when it produced none for a structural
  // reason (no built layer / table not queryable) rather than "columns are all clean".
  const [profileReason, setProfileReason] = useState<string | null>(null);
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

  // ---- auto-Gold: the central honest outcome of the automatic pass-through Gold that
  //      fires after an ingested bronze/silver build (the Gold UI is gone from Edit, but
  //      metrics/dashboards require a built Gold). Same governed route the old manual
  //      "Pass through Gold" button used; never silent, never faked. ----
  const [autoGold, setAutoGold] = useState<BuildResult | null>(null);
  const [autoGolding, setAutoGolding] = useState(false);

  // ---- inline rename of the display name (edit-gated; the physical slug is frozen
  //      server-side so no Iceberg/dbt table ever moves) ----
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameErr, setRenameErr] = useState('');

  // ---- sharing / promotion (mirrors Files: gate hint + button + request status) ----
  const [promote, setPromote] = useState<PromoteStatus | null>(null);
  const [certifyPending, setCertifyPending] = useState(false);
  // Personal data before Company: the server's check (GET certify), a 409 refusal, the certifier's confirmation.
  const [pdStatus, setPdStatus] = useState<PersonalDataStatus | null>(null);
  const [pdRefusal, setPdRefusal] = useState<PersonalDataRefusal | null>(null);
  const [pdConfirm, setPdConfirm] = useState<PersonalDataConfirm>({ confirmed: false, reason: '' });
  // True when the promotion-gate READ failed. Distinct from "the gate is red": an
  // unknown gate must not render as a green one.
  const [gateUnknown, setGateUnknown] = useState(false);
  const [shareErr, setShareErr] = useState('');
  // `?panel=versions` (the Monitoring detail's link) opens the Versions panel directly.
  const [showDataVersions, setShowDataVersions] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('panel') === 'versions');
  const [shareBusy, setShareBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const [dsRes, chkRes] = await Promise.all([
        fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' }),
        fetch(`/api/data/datasets/${datasetId}/checks`, { cache: 'no-store' }),
      ]);
      const dsData = await dsRes.json();
      if (!dsRes.ok) { setLoadErr(dsData.error ?? t('builder.errors.load')); return; }
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
  }, [datasetId, t]);

  useEffect(() => { load(); }, [load]);

  // Sharing gate + in-flight request — the SAME source the Promote panel uses.
  const loadPromote = useCallback(async () => {
    try {
      const [pRes, cRes] = await Promise.all([
        fetch(`/api/data/datasets/${datasetId}/promote`, { cache: 'no-store' }),
        fetch(`/api/data/datasets/${datasetId}/certify`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) { setPromote(await pRes.json()); setGateUnknown(false); }
      // A SWALLOWED GATE READ IS NOT A GREEN GATE. `promote === null` made `gateBlocked`
      // false, so a failed read rendered an ENABLED "Promote to Domain" with no hint —
      // the user then met the server's refusal only after clicking. Record that the gate
      // could not be read and say so on the control instead of guessing.
      else setGateUnknown(true);
      if (cRes.ok) {
        const c = await cRes.json();
        setCertifyPending(c.request?.status === 'pending');
        setPdStatus((c.personalData as PersonalDataStatus | undefined) ?? null);
      }
    } catch {
      setGateUnknown(true);
    }
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
      if (!res.ok) { setShareErr(data.error ?? t('builder.errors.requestPromotion')); return; }
      const approval = data.approval as FiledApproval | undefined;
      if (approval?.id) notifyApprovalFiled(approval, 'dataset', () => { void Promise.all([loadPromote(), load()]); });
      await Promise.all([loadPromote(), load()]);
    } catch (e) { setShareErr((e as Error).message); } finally { setShareBusy(false); }
  }, [datasetId, loadPromote, load, notifyApprovalFiled, t]);

  // An Admin certifies a Shared asset directly; a Creator/Builder files a request.
  const certifyAsset = useCallback(async (mode: 'certify' | 'request', confirm?: PersonalDataConfirm) => {
    setShareErr(''); setShareBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/certify`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: mode, ...(confirm ? { personalData: confirm } : {}) }),
      });
      const data = await res.json();
      // The personal-data rule refused: show the columns, the fix and (where allowed) the confirm box.
      if (res.status === 409 && typeof data.code === 'string' && data.code.startsWith('personal_data_') && data.personalData) {
        setPdRefusal({ code: data.code, error: data.error, personalData: data.personalData });
        return;
      }
      if (!res.ok) { setShareErr(data.error ?? t('builder.errors.certify')); return; }
      setPdRefusal(null);
      setPdConfirm({ confirmed: false, reason: '' });
      // Certified, but the immediate query-engine policy push failed — say so, never silent.
      if (typeof data.warning === 'string') setShareErr(data.warning);
      const approval = data.approval as FiledApproval | undefined;
      if (approval?.id) notifyApprovalFiled(approval, 'dataset', () => { void Promise.all([loadPromote(), load()]); });
      await Promise.all([loadPromote(), load()]);
    } catch (e) { setShareErr((e as Error).message); } finally { setShareBusy(false); }
  }, [datasetId, loadPromote, load, notifyApprovalFiled, t]);

  // RE-MATERIALIZE the governed domain table (#96 self-heal): re-run the stored publish CTAS
  // for a promoted dataset whose domain gold table drifted away (missing/stale). Reuses the
  // gold-join route's `rematerializeOnly` repair mode; on ✓ it reloads so the STALE banner clears.
  const [rematBusy, setRematBusy] = useState(false);
  const [rematErr, setRematErr] = useState('');
  const rematerialize = useCallback(async () => {
    setRematErr(''); setRematBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/gold-join`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rematerializeOnly: true }),
      });
      const data = await res.json();
      if (!res.ok) { setRematErr(data.error ?? data?.domainTable?.reason ?? t('builder.errors.rematerialize')); return; }
      await load();
    } catch (e) { setRematErr((e as Error).message); } finally { setRematBusy(false); }
  }, [datasetId, load, t]);

  const saveDocs = useCallback(async () => {
    setDocsErr(''); setDocsOk(''); setDocsBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: desc, columns: cols.filter((c) => c.name.trim()) }),
      });
      const data = await res.json();
      if (!res.ok) { setDocsErr(data.error ?? t('builder.errors.saveDocs')); return; }
      setDocsOk(t('builder.docs.saved'));
      setDataset((prev) => prev ? { ...prev, description: data.dataset.description, columns: data.dataset.columns } : prev);
      setPdRefusal(null);
      void loadPromote(); // the personal-data check follows the new classification
    } catch (e) {
      setDocsErr((e as Error).message);
    } finally {
      setDocsBusy(false);
    }
  }, [datasetId, desc, cols, loadPromote, t]);

  const addRuleWith = useCallback(async (
    kind: DataCheckRule, column: string,
    extra: { values?: string[]; min?: number; max?: number; description?: string } = {},
  ) => {
    if (!column.trim()) { setChecksErr(t('builder.errors.pickColumn')); return; }
    setChecksErr(''); setChecksBusy(true);
    const payload: Record<string, unknown> = { rule: kind, column: column.trim(), ...extra };
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setChecksErr(data.error ?? t('builder.errors.addRule')); return; }
      setChecks((prev) => [...prev, data.check]);
    } catch (e) {
      setChecksErr((e as Error).message);
    } finally {
      setChecksBusy(false);
    }
  }, [datasetId, t]);

  const ruleDraft = { column: ruleColumn, values: ruleValues, min: ruleMin, max: ruleMax, toDataset: ruleToDataset, toColumn: ruleToColumn };
  const addRule = useCallback(async () => {
    await addRuleWith(ruleKind, ruleColumn, addPayload(ruleKind, { column: ruleColumn, values: ruleValues, min: ruleMin, max: ruleMax, toDataset: ruleToDataset, toColumn: ruleToColumn }));
    if (!checksErr) { setRuleColumn(''); setRuleValues(''); setRuleMin(''); setRuleMax(''); setRuleToDataset(''); setRuleToColumn(''); }
  }, [ruleKind, ruleColumn, ruleValues, ruleMin, ruleMax, ruleToDataset, ruleToColumn, addRuleWith, checksErr]);

  // The Checks section's primary "Save Data Quality Checks" action. Authored rules and
  // monitor toggles ALREADY persist the instant they change (POST /checks, POST /dq —
  // their own governed routes), so this is the one obvious closing action: it flushes any
  // half-filled rule still sitting in the "Add a custom check" editor, then confirms the
  // saved state honestly. It never invents a new write path.
  const saveChecks = useCallback(async () => {
    setChecksSavedNote('');
    if (ruleColumn.trim()) await addRule();
    // Persist any edited/AI-drafted rule descriptions (text only — the rule itself is
    // untouched). Only send the ones that actually changed from what's stored.
    const changed = checks
      .filter((c) => descDrafts[c.id] !== undefined && descDrafts[c.id].trim() !== (c.description ?? '').trim())
      .map((c) => ({ id: c.id, description: descDrafts[c.id].trim() }));
    if (changed.length > 0) {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'describe', descriptions: changed }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) setChecks(data.checks ?? checks);
        else { setChecksErr(data.error ?? t('builder.errors.saveDescriptions')); return; }
      } catch (e) { setChecksErr((e as Error).message); return; }
    }
    setChecksSavedNote(t('builder.checks.saved'));
  }, [ruleColumn, addRule, checks, descDrafts, datasetId, t]);

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
      // Honest empty-state: when nothing could be profiled, keep the reason so the Checks
      // panel shows one quiet line instead of a blank void (curated datasets have only
      // their composed Gold — no bronze/silver fallback — so this is where "build it first"
      // must be said out loud, not swallowed).
      setProfileReason(data.profiled === false ? (data.reason as string | undefined) ?? null : null);
      setTrend((data.trend ?? []) as TrendPoint[]);
      setMonitors((data.monitors ?? []) as MonitorToggle[]);
      const latest = data.latest as { badge?: QualityBadge; healthScore?: number | null; ranAt?: string; source?: 'dagster' | 'os' } | null;
      setDqSource(latest?.source);
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
      const extra: { values?: string[]; min?: number; max?: number; description?: string } = {};
      if (s.rule === 'accepted_values' && s.values) extra.values = s.values;
      if (s.rule === 'range') { if (typeof s.min === 'number') extra.min = s.min; if (typeof s.max === 'number') extra.max = s.max; }
      if (s.description) extra.description = s.description; // land documented — no extra step.
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
        const extra: { values?: string[]; min?: number; max?: number; description?: string } = {};
        if (s.rule === 'accepted_values' && s.values) extra.values = s.values;
        if (s.rule === 'range') { if (typeof s.min === 'number') extra.min = s.min; if (typeof s.max === 'number') extra.max = s.max; }
        if (s.description) extra.description = s.description; // land documented — no extra step.
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
    // Executable DQ on a LIVE connected table scans the source (bounded, but real). Confirm
    // first and steer to a synced copy — honest about running a real query on live data.
    if (dataset?.origin === 'connected' && dataset.connected?.mode === 'live') {
      const ok = typeof window === 'undefined' || window.confirm(
        t('builder.confirmLiveRun'),
      );
      if (!ok) return;
    }
    setRunErr(''); setRunning(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run' }),
      });
      const data = await res.json();
      if (!res.ok) { setRunErr(data.error ?? t('builder.errors.runChecks')); return; }
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
  }, [datasetId, loadDq, dataset?.origin, dataset?.connected?.mode, t]);

  // Governed 50-row preview — the SAME OPA-checked read path. A stage names the LAYER it
  // wants (`?layer=`); omitting it lets the server pick the highest built layer. The
  // requested layer is remembered so "Refresh preview" re-reads the same one.
  const [previewLayer, setPreviewLayer] = useState<Layer | null>(null);
  const loadPreview = useCallback(async (which?: Layer | null) => {
    const layerParam = typeof which === 'undefined' ? previewLayer : which;
    setPreviewLayer(layerParam ?? null);
    setPreviewErr(''); setPreviewing(true);
    try {
      const qs = layerParam ? `layer=${layerParam}&limit=50` : 'limit=50';
      const res = await fetch(`/api/data/datasets/${datasetId}/preview?${qs}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setPreviewErr(data.error ?? t('builder.errors.preview')); return; }
      setPreview(data as RowPreview);
    } catch (e) {
      setPreviewErr((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }, [datasetId, previewLayer, t]);
  useEffect(() => { void loadPreview(null); }, [datasetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The governed 50-row data preview, as a reusable block so EVERY stage can show
  // "what's in the table right now". Each stage frames it to ITS OWN layer: `layer` names
  // which medallion table to read (Bronze/Silver/Gold), and `built` says whether that layer
  // exists yet — an unbuilt layer shows an honest "not built yet" note instead of silently
  // falling back to a different layer's rows. Omit `layer` to read the highest built layer.
  // View's data preview defaults to the HIGHEST built layer (Gold when it exists) with a
  // Bronze·Silver·Gold toggle; only built layers are offered. null = follow the default.
  // (Edit no longer has opt-in "👁 Preview" buttons — the simplified surface leaves the
  // full preview, with its layer toggle, to View.)
  const [viewLayer, setViewLayer] = useState<Layer | null>(null);

  const rowPreviewBlock = (
    heading: string,
    subtitle: string,
    opts: { layer?: Layer; built?: boolean; unbuiltNote?: string; extra?: React.ReactNode } = {},
  ) => {
    const { layer, built = true, unbuiltNote, extra } = opts;
    return (
    <>
      <div className="section-title" style={{ marginTop: 22 }}>
        {heading}
        {built ? (
          <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={() => loadPreview(layer ?? null)} disabled={previewing}>
            {previewing ? <span className="spin" /> : t('builder.preview.refresh')}
          </button>
        ) : null}
        {extra}
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{subtitle}</p>
      {!built ? (
        <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>{unbuiltNote ?? t('builder.preview.unbuilt')}</p>
      ) : (
      <>
      {previewErr ? <QueryError error={previewErr} style={{ marginBottom: 10 }} /> : null}
      {preview ? (
        preview.available ? (
          <>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              {t('builder.preview.firstRows', { count: preview.rowCount, layer: layerWord(preview.layer, t) })}{' · '}<span className="mono" style={{ fontSize: 10 }}>{preview.fqn}</span>
            </p>
            {preview.columns.length > 0 ? (
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table>
                  <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>{t('builder.preview.noRows')}</p>}
          </>
        ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>{preview.reason}</p>
      ) : null}
      </>
      )}
    </>
    );
  };

  // File a set of AI-drafted quality rules into the editable rule cards (each validated +
  // governed by the checks route). Shared by the Define draft and the Validate-stage
  // "Suggest quality rules" action, so a suggested rule ALWAYS lands as an editable card,
  // never as prose the user can't accept.
  const fileChecks = useCallback((checks: DefineDraft['checks']) => {
    for (const chk of checks ?? []) {
      if (chk && RULE_KINDS.has(chk.rule as DataCheckRule) && typeof chk.column === 'string' && chk.column.trim()) {
        const extra: { values?: string[]; min?: number; max?: number } = {};
        if (chk.rule === 'accepted_values' && Array.isArray(chk.values)) extra.values = chk.values.filter((v) => typeof v === 'string');
        if (chk.rule === 'range') { if (typeof chk.min === 'number') extra.min = chk.min; if (typeof chk.max === 'number') extra.max = chk.max; }
        void addRuleWith(chk.rule as DataCheckRule, chk.column, extra);
      }
    }
  }, [addRuleWith]);

  // Apply an assistant Define draft into the docs + quality-rule editors (never auto-saves).
  const applyDraft = useCallback((draft: DefineDraft) => {
    if (typeof draft.description === 'string' && draft.description.trim()) setDesc(draft.description.trim());
    if (Array.isArray(draft.columns) && draft.columns.length > 0) {
      const known = new Map(cols.filter((c) => c.name.trim()).map((c) => [c.name, c.description]));
      for (const c of draft.columns) if (typeof c?.name === 'string' && c.name.trim()) known.set(c.name.trim(), c.description ?? '');
      // A draft never touches the personal-data classification: keep what each column had.
      const personal = new Map(cols.filter((c) => typeof c.personalData === 'boolean').map((c) => [c.name, c.personalData]));
      const merged = Array.from(known, ([name, description]) => withPersonalData({ name, description }, personal.get(name)));
      setCols(merged.length ? merged : [{ name: '', description: '' }]);
    }
    fileChecks(draft.checks);
  }, [cols, fileChecks]);

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
      documented: dataset.columns.some((c) => !!c.description?.trim()),
    };
  }, [dataset]);

  // The staged StageShell walk RETIRES for Data (0.6.44): the detail is now a plain
  // View⇄Edit surface, mirroring MetricBuilder/DashboardBuilder — the OS-wide contract.
  //   • curated = composed from existing governed datasets (Compose editor, no Ingest/Silver).
  //   • legacy grandfathering = an INGESTED dataset whose stored goldSpec already has joins
  //     keeps the join editor visible (nothing breaks).
  const curated = dataset?.origin === 'curated';
  const legacyJoins = (dataset?.goldSpec?.joins?.length ?? 0) > 0;
  // CONNECTED (adopted from a warehouse exposure) — like curated, it has no Ingest/Refine;
  // it shows a Source stage instead. `connectedInfo` present ⇒ the dataset IS an external
  // table (live-federated). A revoked source disables preview/Talk (no data shown).
  const connectedInfo = dataset?.origin === 'connected' ? dataset.connected : undefined;
  const isConnected = !!connectedInfo;
  const sourceRevoked = connectedInfo?.status === 'source-revoked';
  // A revoked LIVE source has NO data (suppress Talk/preview/stats). A revoked SYNC source
  // keeps its last-landed copy — frozen but fully queryable — so data stays available.
  const dataSuppressed = sourceRevoked && connectedInfo?.mode === 'live';

  // View ⇄ Edit. A dataset with nothing materialized (fresh, just-created — the "new"
  // signal, no new prop needed) opens in EDIT (the natural build entry); anything with a
  // built layer opens in VIEW (its calm home to talk to / see / quality-check the data).
  // Once the user is here, the header toggle switches freely (edit-gated).
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (landed || !dataset) return;
    setMode(ctx.materialized ? 'view' : 'edit');
    setLanded(true);
  }, [dataset, ctx, landed]);

  // Ground "Ask the OS" on the dataset + mode currently open here, so a request like
  // "document the columns" acts on THIS dataset without asking for an id. The internal
  // stage id stays 'publish' (View) / 'harmonize' (Edit) so stored anchors + routes never move.
  usePublishPageContext({
    tab: 'data',
    stage: mode === 'view' ? 'publish' : 'harmonize',
    artifactType: 'dataset',
    artifactId: datasetId,
    artifactName: dataset?.name,
  });

  if (loadErr) {
    return (
      <>
        <button className="btn ghost" onClick={onBack}>{t('builder.back')}</button>
        <div className="error" style={{ marginTop: 14 }}>{loadErr}</div>
      </>
    );
  }
  if (!dataset) return <div className="stub-page">{t('builder.loading')}</div>;

  const layer = furthestBuilt(dataset.versions);
  const fqn = layer ? physicalFqn(dataset, layer) : null;
  const metricReady = isMetricReady(dataset);
  const published = !!dataset.certification;
  const canEdit = !!user && canManageArtifact(user, { owner: dataset.owner, domain: dataset.domain });
  const isAdmin = user?.role === 'admin';

  const builtLayers = (['bronze', 'silver', 'gold'] as Layer[]).filter((l) => dataset.versions[l].built);
  const colNames = dataset.columns.map((c) => c.name).filter(Boolean);
  const canRefineSilver = dataset.versions.bronze.built;
  const canHarmonizeGold = dataset.versions.silver.built;

  // The governed promote/certify affordance — in the detail HEADER (beside the lifecycle
  // controls), so promotion is reachable from both View and Edit, mirroring the
  // Metrics/Dashboards header pattern. The gating is UNCHANGED: the
  // transparency gate (promote.gate), the pending-request pill, the role floors (canEdit /
  // isAdmin) and the Bronze-can't-promote rule all read the SAME state and handlers as
  // before — this is a relocation, not a reimplementation. `compact` trims the copy for the
  // header row (the full explanatory sentences belonged to the stage body).
  const promoteBlock = (compact = false) => {
    if (dataset.tier === 'dataset') {
      if (!canHarmonizeGold) {
        // Bronze-only: can't promote until refined to Silver/Gold.
        return (
          <span className="gate-check" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge vis-personal">{t('builder.promote.personal')}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {t.rich('builder.promote.rawBronze', { strong: (c) => <strong>{c}</strong> })}
            </span>
          </span>
        );
      }
      if (promote?.request?.status === 'pending') {
        return (
          <span className="gate-check" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge vis-personal">{t('builder.promote.personal')}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>{t.rich('builder.promote.requested', { strong: (c) => <strong>{c}</strong> })}</span>
          </span>
        );
      }
      if (!canEdit) {
        return (
          <span className="gate-check" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge vis-personal">{t('builder.promote.personal')}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>{t('builder.promote.privateTo', { owner: dataset.owner })}</span>
          </span>
        );
      }
      const gateBlocked = !!(promote && !promote.gate.ok);
      return (
        <span className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!compact ? <span className="badge vis-personal">{t('builder.promote.personal')}</span> : null}
          <button className="btn" disabled={shareBusy || gateBlocked} onClick={requestPromote}
            title={gateBlocked ? t('builder.promote.gateTitle', { missing: promote!.gate.missing.join(', ') }) : t('builder.promote.approveTitle')}>
            {shareBusy ? <span className="spin" /> : t('builder.promote.promote')}
          </button>
          {gateBlocked && !compact ? <span className="hint" style={{ margin: 0 }}>{t('builder.promote.toShare', { missing: promote!.gate.missing.join(', ') })}</span> : null}
          {gateUnknown && !compact ? (
            <span className="hint" style={{ margin: 0 }}>{t('builder.promote.gateUnknown')}</span>
          ) : null}
        </span>
      );
    }
    if (dataset.tier === 'asset') {
      if (certifyPending) {
        return (
          <span className="gate-check gate-ok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge vis-shared">{t('builder.promote.domain')}</span>
            <span className="muted" style={{ fontSize: 12.5 }}>{t.rich('builder.promote.certRequested', { strong: (c) => <strong>{c}</strong> })}</span>
          </span>
        );
      }
      return (
        <span className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!compact ? <span className="badge vis-shared">{t('builder.promote.domain')}</span> : null}
          {isAdmin ? (
            <button className="btn" disabled={shareBusy} onClick={() => certifyAsset('certify')} title={t('builder.promote.certifyTitle')}>
              {shareBusy ? <span className="spin" /> : t('builder.promote.certify')}
            </button>
          ) : canEdit ? (
            <button className="btn ghost" disabled={shareBusy} onClick={() => certifyAsset('request')} title={t('builder.promote.requestTitle')}>
              {shareBusy ? <span className="spin" /> : t('builder.promote.request')}
            </button>
          ) : <span className="muted" style={{ fontSize: 12.5 }}>{t('builder.promote.adminCertifies')}</span>}
          {/* REVERSE move (restored): Domain → My. Confirm dialog + role/lineage gates
              re-enforced by the store (blocked while named individuals hold grants). */}
          {canEdit ? (
            <DemoteButton
              kind="dataset"
              tier="Shared"
              artifactId={dataset.id}
              demoteUrl={`/api/data/datasets/${dataset.id}/lifecycle`}
              onDone={() => { void Promise.all([loadPromote(), load()]); }}
              label={t('builder.promote.demoteToMy')}
            />
          ) : null}
        </span>
      );
    }
    if (dataset.tier === 'product') {
      return (
        <span className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge vis-certified">{t('builder.promote.company')}</span>
          <span className="muted" style={{ fontSize: 12.5 }}>{t('builder.promote.certifiedProduct')}</span>
          {/* REVERSE move: Company → Domain (admin only; blocked while domains import it). */}
          {isAdmin ? (
            <DemoteButton
              kind="dataset"
              tier="Marketplace"
              artifactId={dataset.id}
              demoteUrl={`/api/data/datasets/${dataset.id}/lifecycle`}
              onDone={() => { void Promise.all([loadPromote(), load()]); }}
              label={t('builder.promote.demoteToDomain')}
            />
          ) : null}
        </span>
      );
    }
    return null;
  };

  // A build committed → reload the honest built state (the flat Edit sections re-derive
  // from the fresh dataset). The staged advance/✓ machinery is gone with the stepper —
  // in a single-scroll Edit surface every section is already visible; a commit just
  // reloads. `onContinue` from a panel (its old "Continue to Validate →") reloads too:
  // the Checks section sits right below, no navigation needed.
  const onBuilt = () => { void load(); };

  // Auto-Gold: after an INGESTED bronze/silver build, automatically fire the SAME governed
  // pass-through Gold the old manual button used (POST /version {layer:'gold',
  // passThrough:true}) — the Gold UI is gone from Edit, but metrics/dashboards require a
  // built Gold (metricSqlReady). We reload from the FRESH dataset first (so the decision +
  // the route see the just-committed layer), decide with the pure rule, then fire and
  // surface the honest outcome in a central dialog. A pass-through failure shows the real
  // error; it is never silent, never faked. Curated is excluded (it composes its own Gold).
  const buildThenAutoGold = async (just: 'bronze' | 'silver') => {
    const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    const fresh = res.ok ? (data?.dataset as Dataset | undefined) : undefined;
    if (fresh) {
      // Reflect the just-committed layer immediately (the Edit sections re-derive from this).
      setDataset(fresh);
      setDesc(fresh.description ?? '');
      setCols(fresh.columns?.length ? fresh.columns : [{ name: '', description: '' }]);
    } else {
      void load();
    }
    if (!fresh || !shouldAutoGold(fresh, just)) return;
    setAutoGolding(true);
    try {
      const gRes = await fetch(`/api/data/datasets/${datasetId}/version`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layer: 'gold', passThrough: true }),
      });
      const gData = await gRes.json().catch(() => ({}));
      if (!gRes.ok || gData.error || (gData.build && !gData.build.ok)) {
        setAutoGold({
          ok: false,
          what: t('builder.autoGold.whatFailed'),
          detail: gData.error ?? t('builder.autoGold.failedDetail'),
        });
        return;
      }
      // Honest success: name the automatic step so the user knows Gold was served for them.
      setAutoGold({
        ok: true,
        what: t('builder.autoGold.what'),
        detail: t('builder.autoGold.okDetail'),
        offline: gData.build?.mode === 'offline-mock',
      });
      await load();
    } catch (e) {
      setAutoGold({ ok: false, what: t('builder.autoGold.whatFailed'), detail: (e as Error).message });
    } finally {
      setAutoGolding(false);
    }
  };

  // Rename the dataset (display name only). The store freezes the physical slug before
  // the name changes, so every FQN/dbt identity stays pinned to the real table.
  const rename = async () => {
    const name = nameDraft.trim();
    setRenameErr('');
    if (!name) { setRenaming(false); return; }
    const res = await fetch(`/api/data/datasets/${datasetId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRenameErr(d.error ?? t('builder.errors.rename')); return; }
    setRenaming(false);
    await load();
  };

  return (
    <ConfirmProvider>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost" onClick={onBack}>{t('builder.back')}</button>
        {/* One surface: a published dataset lands on the View stage (its calm home) with the
            stepper right there to edit earlier stages — no separate landing variant to keep. */}
        <BuilderModeToggle
          mode={viewMode}
          onChange={setModePersisted}
          developerHint={t('builder.header.developerHint')}
        />
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
              aria-label={t('builder.header.nameAria')}
            />
            <button className="btn primary sm" onClick={() => void rename()}>{t('builder.header.save')}</button>
            <button className="btn ghost sm" onClick={() => setRenaming(false)}>{t('builder.header.cancel')}</button>
          </span>
        ) : (
          <h2 className="stepper-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', display: 'flex', alignItems: 'center', gap: 10 }}>
            {dataset.name}
            {/* The dataset id in small gray monospace — makes support/debugging (and copying an
                id into a query) trivial without opening the network tab. */}
            <span className="muted" style={{ fontSize: 11, fontWeight: 400, fontFamily: 'var(--font-mono, monospace)', opacity: 0.55, flex: 'none' }} title={t('builder.header.idTitle')}>{dataset.id}</span>
            {/* Rename must be DISCOVERABLE — a labelled button, not a bare glyph
                (user feedback 2026-07-31: the pencil-only affordance read as missing). */}
            {canEdit ? (
              <button
                className="btn ghost sm"
                style={{ flex: 'none' }}
                onClick={() => { setNameDraft(dataset.name); setRenameErr(''); setRenaming(true); }}
                title={t('builder.header.renameTitle')}
                aria-label={t('builder.header.renameAria')}
              >{t('builder.header.rename')}</button>
            ) : null}
          </h2>
        )}
        <span className={`badge ${TIER_BADGE[dataset.tier]}`}>{t(TIER_WORD[dataset.tier])}</span>
        {renameErr && <span className="badge err" style={{ fontSize: 11 }}>{renameErr}</span>}
        {/* Header actions: the lifecycle/governance cluster (promote/certify +
            archive/versions) is reachable from BOTH View and Edit — once you press View of
            an artifact you can Promote/Archive/see Versions without entering Edit (the
            OS-wide rule the Metrics/Knowledge/Connections tabs already follow). Only the
            View⇄Edit toggle itself changes between modes. Governance is UNCHANGED: same
            promoteBlock, same LifecycleActions, same canEdit/isAdmin gates. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {mode === 'view' ? (
            canEdit && viewMode === 'simple' ? (
              <button
                className="btn ghost sm"
                onClick={() => setMode('edit')}
                title={curated ? t('builder.header.editTitleCurated') : t('builder.header.editTitle')}
              >{t('builder.header.edit')}</button>
            ) : null
          ) : (
            canEdit && viewMode === 'simple' ? (
              <button
                className="btn ghost sm"
                onClick={() => setMode('view')}
                title={t('builder.header.viewTitle')}
              >{t('builder.header.view')}</button>
            ) : null
          )}
          {promoteBlock(true)}
          {canEdit ? (
            <LifecycleActions
              id={dataset.id}
              name={dataset.name}
              kind="dataset"
              visibility={lcVis(dataset.tier)}
              archived={!!dataset.archived}
              api={`/api/data/datasets/${dataset.id}`}
              onChanged={() => { if (dataset.archived) onBack(); else void load(); }}
              showVersions={false}
              compact
            />
          ) : null}
          <button
            type="button"
            className={`btn ghost sm${showDataVersions ? ' on' : ''}`}
            onClick={() => setShowDataVersions((v) => !v)}
            aria-expanded={showDataVersions}
            title={t('builder.header.versionsTitle')}
          >
            {showDataVersions ? t('builder.header.hideVersions') : t('builder.header.versions')}
          </button>
        </div>
      </div>
      {showDataVersions ? (
        <div className="lc-history-panel">
          <DatasetVersions datasetId={dataset.id} name={dataset.name} canEdit={canEdit} onRestored={() => void load()} />
        </div>
      ) : null}
      {shareErr ? <div className="error" style={{ marginTop: -6, marginBottom: 12 }}>{shareErr}</div> : null}
      {dataset.tier === 'asset' && (isAdmin || canEdit) ? (
        <PersonalDataCertifyCheck
          status={pdStatus}
          refusal={pdRefusal}
          canConfirm={isAdmin}
          confirm={pdConfirm}
          onConfirmChange={setPdConfirm}
          onConfirmAndCertify={() => { void certifyAsset('certify', pdConfirm); }}
          busy={shareBusy}
        />
      ) : null}


      {viewMode === 'simple' ? (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* ─────────────── Ingestion (Edit · ingested only) ───────────────
            Bring the source data in. A curated dataset has no source of its own — no
            Ingestion, no Transformation (those belong to the source datasets); it starts
            at Composition. Plain-language: no Bronze/Silver/Gold words. The full preview
            (with the layer toggle) lives in View — Edit stays calm. Internal anchor +
            route ids (data.load / bronze layer) are UNCHANGED. */}
        {/* ─────────────── Source (Edit · connected only) ───────────────
            A connected dataset is an adopted external table — no Ingest/Refine; this Source
            card (connection, FQN, mode/tier, snapshot freshness, drift/revoked, guardrails)
            takes their place, at the same order-1 slot. */}
        {mode === 'edit' && isConnected && connectedInfo ? (
          <div style={{ order: 1 }}>
            <ConnectedSourcePanel connected={connectedInfo} datasetId={dataset.id} />
            {/* A SYNC-mode connected dataset owns a schedule + run history — the same SyncPanel
                the warehouse import uses, so the owner can adjust cadence / "Sync now". A live
                connected dataset has no sync. A frozen (revoked) copy keeps the panel read-only-ish
                (the CronJob is gone; the panel still surfaces the honest run history). */}
            {connectedInfo.mode === 'sync' ? (
              <SyncPanel datasetId={dataset.id} canEdit={canEdit && !sourceRevoked} columns={colNames} />
            ) : null}
          </div>
        ) : null}

        {mode === 'edit' && !curated && !isConnected ? (
          <div style={{ order: 1 }}>
            <div className="section-title" style={{ marginTop: 0 }}>{t('builder.ingestion.title')}</div>
            {canEdit ? (
              <BronzePanel
                datasetId={dataset.id}
                onCommitted={() => { void buildThenAutoGold('bronze'); }}
              />
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>{t('builder.ingestion.ownerOnly')}</p>
            )}

            {/* Keep this in sync — schedule + history for a warehouse-synced source. */}
            {dataset.sync ? (
              <SyncPanel datasetId={dataset.id} canEdit={canEdit} columns={colNames} />
            ) : null}

            {/* Something went wrong bringing data in → one big AI explainer, right where
                the error shows (the old bottom "Assistant" box, built into the flow). */}
            {previewErr || (preview && !preview.available) ? (
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
                <AiAction
                  datasetId={dataset.id} stage="ingest" cta={t('builder.ingestion.explainCta')}
                  title={t('builder.ingestion.explainTitle')}
                  payload={() => ({ name: dataset.name, reason: previewErr || (preview && !preview.available ? preview.reason : '') })}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ─────────────── Documentation (both origins) ───────────────
            Describe the dataset and what each column means. Docs ONLY — the data-shaping
            (Transformation) lives in its own section below. Plain-language section title.
            Internal anchor id (data.document) is UNCHANGED. Curated renders this AFTER
            Composition (order 2 vs Composition's 1); ingested renders it after Ingestion. */}
        {mode === 'edit' ? (
          <div style={{ order: 2 }}>
            <div className="section-title" style={{ marginTop: 0 }}>{t('builder.docs.title')}</div>
            {/* Provenance: docs auto-drafted after ingestion, awaiting a human review. Cleared
                the moment anyone saves the section (the write drops docsProvenance). */}
            {dataset.docsProvenance === 'ai-auto' ? (
              <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px', fontStyle: 'italic' }}>
                {canEdit ? t('builder.docs.aiDraftedEdit') : t('builder.docs.aiDrafted')}
              </p>
            ) : null}
            {/* AI, built into the flow: draft the documentation from the schema. */}
            {canEdit ? (
              <div className="row" style={{ justifyContent: 'flex-end', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
                <AiAction<DefineDraft>
                  datasetId={dataset.id} stage="define" cta={t('builder.docs.draftCta')}
                  title={t('builder.docs.draftTitle')}
                  payload={() => ({ name: dataset.name, prompt: desc, columns: colNames.length ? colNames : cols.map((c) => c.name).filter(Boolean) })}
                  onDraft={applyDraft}
                  successText={t('builder.docs.draftSuccess')}
                />
              </div>
            ) : null}
            {canEdit ? (
              <div className="guided-panel" style={{ marginBottom: 16 }}>
                <label className="muted" style={{ fontSize: 12.5 }}>{t('builder.docs.whatIs')}</label>
                <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('builder.docs.descPlaceholder')} />
                <div className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>{t('builder.docs.columnMeanings')}</div>
                {cols.map((c, i) => (
                  <div className="row" key={i} style={{ gap: 8, marginBottom: 6 }}>
                    <input style={{ maxWidth: 180 }} placeholder={t('builder.docs.columnPlaceholder')} value={c.name}
                      onChange={(e) => setCols((cs) => cs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <input style={{ flex: 1 }} placeholder={t('builder.docs.meaningPlaceholder')} value={c.description}
                      onChange={(e) => setCols((cs) => cs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                    <PersonalDataSelect value={c.personalData}
                      onChange={(v) => setCols((cs) => cs.map((x, j) => j === i ? withPersonalData(x, v) : x))} />
                    <button type="button" className="btn ghost sm" onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))} aria-label={t('builder.docs.removeColumn')}>×</button>
                  </div>
                ))}
                <button className="btn ghost sm" onClick={() => setCols((cs) => [...cs, { name: '', description: '' }])}>{t('builder.docs.addColumn')}</button>
                {docsErr ? <div className="error" style={{ marginTop: 8 }}>{docsErr}</div> : null}
                {/* Section primary action: the one obvious way to close Documentation. */}
                <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                  {docsOk ? <span className="ok-note" style={{ fontSize: 12.5, marginRight: 'auto' }}>{docsOk}</span> : null}
                  <button className="btn primary" onClick={() => { void saveDocs(); }} disabled={docsBusy}>
                    {docsBusy ? <span className="spin" /> : t('builder.docs.save')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p style={{ margin: '0 0 10px', color: dataset.description ? 'var(--text)' : 'var(--text-faint)', fontSize: 14 }}>
                  {dataset.description || t('builder.docs.noDescription')}
                </p>
                {dataset.columns.length > 0 ? (
                  <div className="table-wrap" style={{ marginBottom: 16 }}>
                    <table>
                      <thead><tr><th>{t('builder.docs.colColumn')}</th><th>{t('builder.docs.colDescription')}</th></tr></thead>
                      <tbody>
                        {dataset.columns.map((c) => (
                          <tr key={c.name}><td className="mono" style={{ whiteSpace: 'nowrap' }}>{c.name}</td><td className="muted" style={{ whiteSpace: 'normal' }}>{c.description || '—'}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>{t('builder.docs.noColumnDocs')}</p>}
              </>
            )}
          </div>
        ) : null}

        {/* ─────────────── Transformation (Edit · ingested only) ───────────────
            Clean and conform the ingested data — the Silver build. A CURATED dataset has
            no source of its own (its inputs are already-refined datasets), so there is no
            Transformation — cleaning belongs to the sources. Plain-language section title.
            Internal anchor id (data.clean) + the silver layer/route are UNCHANGED. After a
            successful build the pass-through Gold fires automatically (metrics need Gold).
            Sits AFTER Documentation (order 3), before Checks. */}
        {mode === 'edit' && canEdit && !curated && !isConnected ? (
          <div style={{ order: 3 }}>
            <div className="section-title" style={{ marginTop: 0 }}>{t('builder.transform.title')}</div>
            {/* AI, built into the flow: fill the cleaning plan below ("Clean it up"). */}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 14 }}>
              <AiAction<CleanDraft>
                datasetId={dataset.id} stage="clean" cta={t('builder.transform.cleanCta')}
                title={canRefineSilver ? t('builder.transform.cleanTitle') : t('builder.transform.needIngestTitle')}
                disabled={!canRefineSilver}
                payload={() => ({ name: dataset.name, prompt: desc, columns: colNames })}
                onDraft={setCleanProposal}
                successText={t('builder.transform.cleanSuccess')}
              />
            </div>
            {staleVsBronze(dataset.versions, 'silver') ? (
              <p className="hint" style={{ margin: '0 0 10px' }}>
                {t('builder.transform.stale', { bronze: fmtDate(dataset.versions.bronze.updatedAt, f), silver: fmtDate(dataset.versions.silver.updatedAt, f) })}
              </p>
            ) : null}
            {canRefineSilver ? (
              <RefinePanel
                datasetId={dataset.id} datasetName={dataset.name} laneSlug={dataset.laneSlug ?? physicalSlug(dataset)}
                owner={dataset.owner} domain={dataset.domain} tier={dataset.tier}
                columns={colNames}
                silverBuilt={canHarmonizeGold}
                proposal={cleanProposal}
                saveLabel={t('builder.transform.save')}
                stage={{ layer: 'silver', copy: { title: t('builder.transform.title'), subtitle: '', tool: '' } }}
                onCommitted={() => { void buildThenAutoGold('silver'); }}
                onContinue={onBuilt}
              />
            ) : <p className="muted" style={{ fontSize: 13 }}>{t('builder.transform.needIngest')}</p>}
          </div>
        ) : null}

        {/* ─────────────── Composition (curated) / legacy joins (grandfathered ingested) ─
            CURATED: the CORE editor — pick the base, join in others, keep columns + derived
            fields. That IS curated's purpose, so it renders FIRST (order 1). For an ingested
            dataset this section is GONE (its Gold is served automatically via the pass-through
            after Transformation) — the ONE exception is legacy grandfathering: an ingested
            dataset whose STORED goldSpec already has joins keeps its join editor visible so
            nothing breaks. Internal anchor id (data.harmonize) is UNCHANGED. */}
        {mode === 'edit' && (curated || legacyJoins) ? (
          <div style={{ order: curated ? 1 : 3 }}>
            {canEdit ? (
              <>
                <div className="section-title" style={{ marginTop: 0, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {t('builder.compose.title')}
                  <span className="hint" style={{ margin: '0 0 0 10px' }}>
                    {curated ? t('builder.compose.curatedHint') : t('builder.compose.legacyHint')}
                  </span>
                </div>
                <GoldJoinPanel
                  datasetId={dataset.id} datasetName={dataset.name} laneSlug={dataset.laneSlug ?? physicalSlug(dataset)}
                  owner={dataset.owner} domain={dataset.domain} tier={dataset.tier}
                  columns={colNames}
                  silverBuilt={canHarmonizeGold}
                  goldBuilt={dataset.versions.gold.built}
                  initialSpec={dataset.goldSpec}
                  curated={curated}
                  legacyJoins={legacyJoins}
                  saveLabel={curated ? t('builder.compose.save') : undefined}
                  onCommitted={onBuilt}
                  onContinue={onBuilt}
                />
              </>
            ) : <p className="muted" style={{ fontSize: 13 }}>{t('builder.compose.ownerOnly')}</p>}
          </div>
        ) : null}

        {/* ─────────────── Checks (Edit · both origins, last) ───────────────
            Both the default heuristic monitors ("Default checks") and the authored rules
            ("Custom checks") live here. Plain-language section title. Internal anchor id
            (data.validate) is UNCHANGED. */}
        {mode === 'edit' ? (
          <div style={{ order: 4 }}>
            <div className="section-title" style={{ marginTop: 0 }}>{t('builder.checks.title')}</div>
            {/* AI, built into the flow: one big action at the top — explain the profile's
                suggested checks, or (none yet) suggest which quality rules to author. */}
            <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
              <AiAction<DefineDraft>
                datasetId={dataset.id} stage="validate"
                cta={suggestions.length ? t('builder.checks.explainCta') : t('builder.checks.suggestCta')}
                title={suggestions.length ? t('builder.checks.explainTitle') : t('builder.checks.suggestTitle')}
                // With profile suggestions the reply is prose (explanation) — no onDraft.
                // Without them "Suggest quality rules" returns a structured {checks} draft,
                // which we file as editable rule cards the user can review/override/save.
                onDraft={suggestions.length ? undefined : (draft) => fileChecks(draft.checks)}
                successText={t('builder.checks.suggestSuccess')}
                payload={() => ({
                  name: dataset.name,
                  columns: colNames,
                  // When we have deterministic profile→rule suggestions, hand them to the
                  // model as rendered lines so it explains WHY each matters (rationale layer).
                  ...(suggestions.length ? { suggestions: suggestions.map((s) => `${suggestionText(s, t)} — ${s.evidence}`) } : {}),
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
                <span className="muted" style={{ fontSize: 13 }}>{t('builder.checks.health')}</span>
              </div>
              {trend.length >= 2 ? <Sparkline points={trend} /> : null}
              <div className="muted" style={{ fontSize: 13, display: 'flex', gap: 14, flexWrap: 'wrap', marginLeft: 'auto', alignItems: 'center' }}>
                {health ? (
                  <>
                    <span>{t('builder.checks.passing', { count: health.passing })}</span>
                    <span style={{ color: health.failing > 0 ? 'var(--danger, #d64545)' : undefined }}>{t('builder.checks.failing', { count: health.failing })}</span>
                    <span>{t('builder.checks.notRun', { count: health.notRun })}</span>
                  </>
                ) : <span>{t('builder.checks.notRunYet')}</span>}
                {ranAt ? <span title={t('builder.checks.lastRun', { date: formatDate(ranAt, f) })}>⟳ {formatDate(ranAt, f)}</span> : null}
                {dqSourceKeys(dqSource) ? (
                  <span className="badge muted" title={t(dqSourceKeys(dqSource)!.title)}>{t(dqSourceKeys(dqSource)!.text)}</span>
                ) : null}
              </div>
            </div>

            {/* Suggested checks — deterministic from the profile, each citing its evidence.
                One-click Add, or Accept all. This is where "powerful" hides behind "simple". */}
            {suggestions.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div className="section-title" style={{ marginTop: 0 }}>
                  {t('builder.checks.suggested')}
                  <span className="count-pill">{suggestions.length}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>{t('builder.checks.fromProfile')}</span>
                  {canEdit ? (
                    <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={acceptAllSuggestions} disabled={acceptingAll || suggestBusy}>
                      {acceptingAll ? <span className="spin" /> : t('builder.checks.acceptAll')}
                    </button>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {suggestions.map((s) => (
                    <div key={`${s.rule}:${s.column}`} className="guided-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{suggestionText(s, t)}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{s.evidence}</div>
                      </div>
                      {canEdit ? (
                        <button className="btn sm" onClick={() => acceptSuggestion(s)} disabled={suggestBusy || acceptingAll}>{t('builder.checks.add')}</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Honest empty-state: no deterministic suggestions AND a structural reason
                (unbuilt / unqueryable table — the curated "no bronze/silver fallback" case).
                One quiet line, never a blank void. */}
            {suggestions.length === 0 && profileReason ? (
              <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>{profileReasonText(profileReason, t)}</p>
            ) : null}

            {/* Default checks — heuristic freshness/volume/schema monitors, on by default.
                Monte-Carlo's lesson: coverage without writing rules. Each is explainable
                (mean±kσ / cadence / column-set), contributes to the health score, and honours
                the honesty contract (too little history ⇒ "not run", never a fake pass). These
                come FIRST — a dataset has sensible checks the moment it exists. */}
            {monitors.length > 0 ? (
              <>
                <div className="section-title" style={{ marginTop: 0 }}>
                  {t('builder.checks.defaults')}
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>{t('builder.checks.onByDefault')}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                  {monitors.map((m) => (
                    <div key={m.kind} className="guided-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t(MONITOR_KEYS[m.kind].label)}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{t(MONITOR_KEYS[m.kind].hint)}</div>
                      </div>
                      {canEdit ? (
                        <button
                          className={`btn ghost sm ${m.enabled ? '' : 'off'}`}
                          onClick={() => toggleMonitor(m.kind, !m.enabled)}
                          disabled={monitorBusy === m.kind}
                          aria-pressed={m.enabled}
                        >
                          {monitorBusy === m.kind ? <span className="spin" /> : m.enabled ? t('builder.checks.on') : t('builder.checks.off')}
                        </button>
                      ) : (
                        <span className="muted" style={{ fontSize: 12.5 }}>{m.enabled ? t('builder.checks.on') : t('builder.checks.off')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {/* Custom checks — author rules + run them for real against the built table. */}
            <div className="section-title" style={{ marginTop: 20 }}>
              {t('builder.checks.custom')}
              <span className="count-pill">{checks.length}</span>
              {badge ? (
                <span className={`badge ${badge === 'passing' ? 'vis-shared' : badge === 'failing' ? 'vis-personal' : ''}`} style={{ marginLeft: 10 }} title={ranAt ? t('builder.checks.lastRun', { date: formatDate(ranAt, f) }) : undefined}>
                  {badge === 'passing' ? t('builder.checks.badgePassing') : badge === 'failing' ? t('builder.checks.badgeFailing') : t('builder.checks.badgeNotRun')}
                </span>
              ) : null}
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              {t('builder.checks.customHint')}
            </p>
            {/* One AI action: draft a plain-language description for every rule missing one.
                The text lands in each rule's editable field as a DRAFT — nothing saves until
                you review and press Save Data Quality Checks. */}
            {canEdit && checks.length > 0 ? (
              <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
                <AiAction<{ descriptions?: Array<{ index: number; description: string }> }>
                  datasetId={dataset.id} stage="describe-checks"
                  cta={t('builder.checks.describeCta')}
                  title={t('builder.checks.describeTitle')}
                  successText={t('builder.checks.describeSuccess')}
                  payload={() => ({
                    name: dataset.name,
                    // Only the rules that still need a description; keyed by array index so the
                    // draft maps back exactly. Executable rules only (a bare intention has no ruleText).
                    rules: checks
                      .map((c, index) => ({ index, text: ruleText(c), has: !!(descDrafts[c.id] ?? c.description ?? '').trim() }))
                      .filter((r) => r.text && !r.has)
                      .map((r) => ({ index: r.index, text: r.text })),
                  })}
                  onDraft={(draft) => {
                    const items = Array.isArray(draft.descriptions) ? draft.descriptions : [];
                    setDescDrafts((m) => {
                      const next = { ...m };
                      for (const it of items) {
                        const chk = checks[it.index];
                        if (chk && typeof it.description === 'string' && it.description.trim()) {
                          next[chk.id] = it.description.trim();
                        }
                      }
                      return next;
                    });
                  }}
                />
              </div>
            ) : null}
            {runErr ? <QueryError error={runErr} style={{ marginBottom: 10 }} /> : null}
            {checks.length > 0 ? (
              <div className="table-wrap" style={{ marginBottom: 14 }}>
                <table>
                  <thead><tr><th>{t('builder.checks.colRule')}</th><th>{t('builder.checks.colAddedBy')}</th><th>{t('builder.checks.colResult')}</th>{canEdit ? <th /> : null}</tr></thead>
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
                                r.status === 'pass' ? <span className="status-chip s-searchable" style={{ cursor: 'default' }}>{t('builder.checks.pass')}</span>
                                  : r.status === 'warn' ? <span className="status-chip" style={{ cursor: 'default' }} title={t('builder.checks.warnTitle', { count: String(r.violations ?? '?') })}>{t('builder.checks.warn', { count: String(r.violations ?? '') })}</span>
                                  : r.status === 'fail' ? <span className="status-chip s-stored" style={{ cursor: 'default' }} title={t('builder.checks.failTitle', { count: String(r.violations) })}>{t('builder.checks.fail', { count: String(r.violations) })}</span>
                                    : <span className="muted" title={r.reason}>{t('builder.checks.notRunCell')}</span>
                              ) : <span className="muted">—</span>}
                              {failing ? (
                                <button
                                  className="btn ghost sm"
                                  style={{ marginLeft: 8 }}
                                  aria-expanded={fixOpen === chk.id}
                                  onClick={() => setFixOpen((open) => (open === chk.id ? null : chk.id))}
                                >
                                  {fixOpen === chk.id ? t('builder.checks.hideFixes') : t('builder.checks.fix')}
                                </button>
                              ) : null}
                            </td>
                            {canEdit ? <td><button className="btn ghost sm" onClick={() => deleteRule(chk.id)} aria-label={t('builder.checks.removeRule')}>×</button></td> : null}
                          </tr>
                          {/* Plain-language description — editable per rule (typed or AI-drafted);
                              persisted on Save Data Quality Checks. Read-only viewers see the text. */}
                          <tr>
                            <td colSpan={canEdit ? 4 : 3} style={{ paddingTop: 0 }}>
                              {canEdit ? (
                                <input
                                  aria-label={t('builder.checks.descAria', { rule: ruleText(chk) })}
                                  placeholder={t('builder.checks.descPlaceholder')}
                                  value={descDrafts[chk.id] ?? chk.description ?? ''}
                                  onChange={(e) => setDescDrafts((m) => ({ ...m, [chk.id]: e.target.value }))}
                                  style={{ width: '100%', fontSize: 13 }}
                                />
                              ) : (chk.description ? (
                                <span className="muted" style={{ fontSize: 12.5 }}>{chk.description}</span>
                              ) : null)}
                            </td>
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
            ) : <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>{t('builder.checks.noRules')}</p>}

            {canEdit ? (
              <div className="guided-panel" style={{ padding: '12px 16px' }}>
                <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{t('builder.checks.addCustom')}</div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as DataCheckRule)} style={{ maxWidth: 170 }}>
                    {(Object.keys(RULE_LABELS) as DataCheckRule[]).map((k) => <option key={k} value={k}>{t(RULE_LABEL_KEYS[k])}</option>)}
                  </select>
                  {dataset.columns.length > 0 ? (
                    <select value={ruleColumn} onChange={(e) => setRuleColumn(e.target.value)} style={{ maxWidth: 200 }}>
                      <option value="">{t('builder.checks.columnPick')}</option>
                      {dataset.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  ) : <input style={{ maxWidth: 200 }} placeholder={t('builder.checks.columnPlaceholder')} value={ruleColumn} onChange={(e) => setRuleColumn(e.target.value)} />}
                  {ruleKind === 'accepted_values' ? <input style={{ flex: 1, minWidth: 160 }} placeholder={t('builder.checks.valuesPlaceholder')} value={ruleValues} onChange={(e) => setRuleValues(e.target.value)} /> : null}
                  {ruleKind === 'range' ? (
                    <>
                      <input style={{ maxWidth: 90 }} placeholder={t('builder.checks.minPlaceholder')} value={ruleMin} onChange={(e) => setRuleMin(e.target.value)} inputMode="decimal" />
                      <input style={{ maxWidth: 90 }} placeholder={t('builder.checks.maxPlaceholder')} value={ruleMax} onChange={(e) => setRuleMax(e.target.value)} inputMode="decimal" />
                    </>
                  ) : null}
                  {fieldsFor(ruleKind).includes('toDataset') ? (
                    <>
                      <input style={{ maxWidth: 180 }} placeholder={t('builder.checks.refDatasetPlaceholder')} value={ruleToDataset} onChange={(e) => setRuleToDataset(e.target.value)} />
                      <input style={{ maxWidth: 170 }} placeholder={t('builder.checks.refColumnPlaceholder')} value={ruleToColumn} onChange={(e) => setRuleToColumn(e.target.value)} />
                    </>
                  ) : null}
                  <button className="btn" onClick={addRule} disabled={checksBusy || !canSubmitRule(ruleKind, ruleDraft)}>
                    {checksBusy ? <span className="spin" /> : t('builder.checks.addCheck')}
                  </button>
                </div>
                {checksErr ? <div className="error" style={{ marginTop: 8 }}>{checksErr}</div> : null}
              </div>
            ) : null}

            {/* Section primary action: one obvious way to close Checks. Rules + monitor
                toggles already persist on edit, so Save flushes any half-filled check and
                confirms. "Run checks" is the secondary action beside it (a real pass/fail). */}
            {canEdit ? (
              <div className="row" style={{ marginTop: 14, gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                {checksSavedNote ? <span className="ok-note" style={{ fontSize: 12.5, marginRight: 'auto' }}>{checksSavedNote}</span> : null}
                {checks.length > 0 ? (
                  <button className="btn ghost" onClick={runChecks} disabled={running}>
                    {running ? <span className="spin" /> : t('builder.checks.run')}
                  </button>
                ) : null}
                <button className="btn primary" onClick={() => { void saveChecks(); }} disabled={checksBusy}>
                  {checksBusy ? <span className="spin" /> : t('builder.checks.save')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ─────────────── View (Talk · Stats · Preview · Quality) ───────────────
            The calm home to USE the data — tile click lands here. Reuses the existing
            View/publish content unchanged. */}
        {mode === 'view' ? (
          <div>
            {/* Connected datasets show their Source card first (connection, FQN, freshness,
                drift/revoked, guardrails). A revoked source shows the banner and NO data —
                Talk + preview + stats are suppressed with the honest reason. */}
            {isConnected && connectedInfo ? <ConnectedSourcePanel connected={connectedInfo} datasetId={dataset?.id} /> : null}

            {dataSuppressed ? (
              <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
                {t('builder.view.revoked')}
              </p>
            ) : (
            <>
            {/* Data preview — Gold by default (the highest built layer); the
                   bronze·silver·gold toggle lives IN the preview heading. */}
            {(() => {
              const shownLayer = viewLayer ?? layer;
              const layerToggle = builtLayers.length > 1 ? (
                <span className="seg" style={{ marginLeft: 10 }}>
                  {(['bronze', 'silver', 'gold'] as Layer[]).filter((l) => builtLayers.includes(l)).map((l) => (
                    <button
                      key={l}
                      className={shownLayer === l ? 'on' : ''}
                      onClick={() => { setViewLayer(l); void loadPreview(l); }}
                    >{layerWord(l, t)}</button>
                  ))}
                </span>
              ) : undefined;
              return rowPreviewBlock(
                t('builder.view.previewTitle', { layer: shownLayer ?? 'none' }),
                t('builder.view.previewSubtitle', { layer: shownLayer ?? 'none' }),
                { layer: shownLayer ?? undefined, built: !!shownLayer, unbuiltNote: t('builder.view.unbuiltNote'), extra: layerToggle },
              );
            })()}

            {/* 3. Statistics — the descriptive profile of the highest built layer (per-column
                   type/completeness/distinct/range/top values). Reuses ExplorePanel, stats only. */}
            {builtLayers.length > 0 ? (
              <>
                <div className="section-title" style={{ marginTop: 24 }}>{t('builder.view.statistics')}</div>
                <ExplorePanel datasetId={dataset.id} builtLayers={builtLayers} showPreview={false} />
              </>
            ) : null}

            {/* 4. Data-quality SCORECARD — the authored rules + their latest REAL run, made
                   glanceable: pass-rate hero + bar, then one card per rule. Nothing invented:
                   every number comes from the same checks/results state the Validate editor
                   drives; an unrun rule shows as unrun, never as passing. */}
            <div className="section-title" style={{ marginTop: 26 }}>
              {t('builder.view.quality')}
              {checks.length > 0 ? (
                <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={runChecks} disabled={running}>
                  {running ? <span className="spin" /> : t('builder.checks.run')}
                </button>
              ) : null}
            </div>
            {checks.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
                {t.rich('builder.view.noRules', { strong: (c) => <strong>{c}</strong> })}
              </p>
            ) : (
              <>
                {runErr ? <QueryError error={runErr} style={{ marginBottom: 10 }} /> : null}
                <div className="guided-panel" style={{ marginBottom: 12 }}>
                  <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 120 }}>
                      <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1, color: dqRan === 0 ? 'var(--text-faint, #999)' : dqFailing > 0 ? 'var(--danger, #d64545)' : 'var(--ok, #2e9e6b)' }}>
                        {dqRan === 0 ? '—' : `${Math.round((dqPassing / dqRan) * 100)}%`}
                      </div>
                      <div className="hint" style={{ margin: 0 }}>
                        {dqRan === 0 ? t('builder.view.notYetRun') : t('builder.view.passingOf', { passing: dqPassing, ran: dqRan })}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ height: 8, borderRadius: 4, background: 'var(--border, rgba(0,0,0,0.08))', overflow: 'hidden' }}>
                        {dqRan > 0 ? (
                          <div style={{ height: '100%', width: `${Math.round((dqPassing / dqRan) * 100)}%`, background: dqFailing > 0 ? 'var(--danger, #d64545)' : 'var(--ok, #2e9e6b)', transition: 'width .4s ease' }} />
                        ) : null}
                      </div>
                      <div className="hint" style={{ margin: '6px 0 0' }}>
                        {t('builder.view.rulesAuthored', { count: checks.length })}
                        {dqRan < checks.length ? ` · ${t('builder.view.notYetRunCount', { count: checks.length - dqRan })}` : ''}
                        {ranAt ? ` · ${t('builder.view.lastRun', { date: formatDate(ranAt, f) })}` : ''}
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8, marginBottom: 8 }}>
                  {checks.map((chk) => {
                    const r = results[chk.id];
                    const state = r?.status === 'pass' ? { c: 'var(--ok, #2e9e6b)', g: '✓', label: t('builder.view.cardPass') }
                      : r?.status === 'warn' ? { c: 'var(--warn, #c98a00)', g: '!', label: t('builder.view.cardWarn', { count: String(r.violations ?? '?') }) }
                      : r?.status === 'fail' ? { c: 'var(--danger, #d64545)', g: '✗', label: t('builder.view.cardFail', { count: r.violations ?? 0 }) }
                        : { c: 'var(--text-faint, #999)', g: '•', label: t('builder.view.notYetRun') };
                    // Lead with the plain-language description when present; fall back to the
                    // technical rule text so a card is NEVER blank. The technical text stays
                    // on hover for provenance.
                    const desc = (chk.description ?? '').trim();
                    const primary = desc || ruleText(chk);
                    return (
                      <div key={chk.id} className="guided-panel" style={{ padding: '10px 12px', borderLeft: `3px solid ${state.c}`, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ color: state.c, fontWeight: 700, fontSize: 15 }} aria-hidden>{state.g}</span>
                        <span
                          className={desc ? undefined : 'mono'}
                          style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={desc ? `${desc}\n${ruleText(chk)}` : ruleText(chk)}
                        >
                          {primary}
                        </span>
                        <span className="muted" style={{ fontSize: 12, color: state.c, whiteSpace: 'nowrap' }}>{state.label}</span>
                      </div>
                    );
                  })}
                </div>
                {dqRan === 0 ? (
                  <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{t('builder.view.runHint')}</p>
                ) : null}
              </>
            )}
            </>
            )}

            {/* Configuration drawer (dbt SQL / dataset.yaml) — the technical surface, kept last. */}
            {canEdit ? (
              <>
                <div className="section-title" style={{ marginTop: 24 }}>
                  {t('builder.view.configuration')}
                  <button className={`btn ghost sm${showCode ? ' on' : ''}`} style={{ marginLeft: 10 }} onClick={() => setShowCode((v) => !v)}>
                    {showCode ? t('builder.view.hideCode') : t('builder.view.showCode')}
                  </button>
                </div>
                {showCode ? (
                  <div style={{ marginBottom: 14 }}>
                    <CodeDrawer datasetId={dataset.id} />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      ) : (
        <DataDeveloperView dataset={dataset} datasetId={datasetId} />
      )}

      {/* Auto-Gold outcome — the honest central announcement of the automatic pass-through
          Gold that runs after an ingested bronze/silver build (the Gold UI is gone from Edit,
          but metrics/dashboards require a built Gold). Success says it was served for metrics
          automatically; a failure shows the real error. Never silent, never faked. */}
      {autoGold ? (
        <BuildResultDialog
          result={autoGold}
          onContinue={() => setAutoGold(null)}
          onClose={() => setAutoGold(null)}
        />
      ) : null}

      {/* ── About this dataset — the technical strip, moved to the BOTTOM so the top of
            the page stays calm (owner/ids/status read when you scroll for them). ── */}
      <div style={{ marginTop: 28, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="muted" style={{ fontSize: 13 }}>{dataset.owner} · {dataset.domain}</span>
          {dataset.tier !== 'dataset' ? <DomainTag domain={dataset.domain} /> : null}
          <span className="mono muted" style={{ fontSize: 11 }} title={t('builder.about.idTitle')}>{dataset.id}</span>
          <span className="mono muted" style={{ fontSize: 11 }} title={t('builder.about.tableTitle')}>{t('builder.about.table', { slug: physicalSlug(dataset) })}</span>
          {' '}· <GitHeadBadge kind="dataset" id={dataset.id} />
        </div>
      {/* Domain-table drift (#96): a PROMOTED dataset whose governed domain gold table is
          missing/stale — the detail route probes this physically, so we surface the honest
          state + a prominent repair regardless of the (previously unreliable) stored flag. */}
      {dataset.tier !== 'dataset' && dataset.domainTableStale ? (
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
          <span role="alert" style={{ fontSize: 13 }}>
            {t.rich('builder.about.stale', { strong: (c) => <strong>{c}</strong> })}
          </span>
          {user && roleAtLeast(user.role, 'builder') ? (
            <button className="btn" disabled={rematBusy} onClick={rematerialize} title={t('builder.about.rematTitle')}>
              {rematBusy ? <span className="spin" /> : t('builder.about.remat')}
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>{t('builder.about.builderMust')}</span>
          )}
          {rematErr ? <span className="error" role="alert" style={{ fontSize: 12 }}>{rematErr}</span> : null}
        </div>
      ) : null}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {layer ? (
          <span className="status-chip s-searchable" title={t('builder.about.materializedTitle', { fqn: fqn ?? '' })} style={{ cursor: 'default' }}>
            {t.rich('builder.about.materialized', { layer: layerWord(layer, t), fqn: fqn ?? '', code: (c) => <span className="mono" style={{ fontSize: 10 }}>{c}</span> })}
          </span>
        ) : (
          <span className="status-chip s-stored" title={t('builder.about.notMaterializedTitle')} style={{ cursor: 'default' }}>
            {t('builder.about.notMaterialized')}
          </span>
        )}
        <span className={`badge ${TIER_BADGE[dataset.tier]}`} style={{ alignSelf: 'center' }} title={t('builder.about.tierTitle', { tier: dataset.tier, visibility: dataset.visibility })}>
          {visWord(dataset.visibility, t)}
        </span>
        {metricReady ? (
          <span className="status-chip s-searchable" title={t('builder.about.metricReadyTitle')} style={{ cursor: 'default' }}>{t('builder.about.metricReady')}</span>
        ) : (
          <span className="status-chip s-stored" title={dataset.tier === 'dataset' ? t('builder.about.metricNotReadyPersonalTitle') : t('builder.about.metricNotReadyGoldTitle')} style={{ cursor: 'default' }}>{t('builder.about.metricNotReady')}</span>
        )}

        {published ? (
          <span className={`badge cert-${dataset.certification!.level}`} title={t('builder.about.certifiedTitle', { level: dataset.certification!.level, by: dataset.certification!.by, date: formatDate(dataset.certification!.at, f) })} style={{ cursor: 'default' }}>
            {t('builder.about.certified', { level: dataset.certification!.level })}
          </span>
        ) : (
          <span className="status-chip s-stored" title={t('builder.about.notCertifiedTitle')} style={{ cursor: 'default' }}>{t('builder.about.notCertified')}</span>
        )}
      </div>
      {/* night-2 stream T: the tool-native artefacts of this data product. */}
      <TechnicalDetailsOnly><UnderTheHood kind="dataset" id={dataset.id} /></TechnicalDetailsOnly>
      <CloneRepository domain={dataset.domain} />
      </div>
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
 *   3. The metric model YAML — generated from the governed dataset itself
 *      endpoint which builds it from the SAME registry the builder holds.
 *   4. Governance/RLS summary — tier, visibility, domain, certification status.
 *
 * Read-only with a clear label. If a piece isn't available yet, an honest
 * placeholder is shown rather than fabricated content.
 */
function DataDeveloperView({ dataset, datasetId }: { dataset: Dataset; datasetId: string }) {
  const t = useTranslations('data');
  const f = useFormat();
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

  /* ── Metric model YAML — the OS's OWN definition for this dataset ───────── */
  // Generated server-side from the governed dataset (gold columns → dimensions,
  // declared measures → measures): EXACTLY the definition the metric path compiles to
  // Trino SQL. No external semantic-layer service is involved.
  const [metricYaml, setMetricYaml] = useState<string | null>(null);
  const [modelErr, setModelErr] = useState('');
  useEffect(() => {
    if (!isMetricReady(dataset)) return; // only worth fetching if Gold + governed
    (async () => {
      setModelErr('');
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/metric-model`, { cache: 'no-store' });
        if (!res.ok) { setModelErr(t('builder.dev.modelUnavailable')); return; }
        const data = (await res.json()) as { model?: string };
        setMetricYaml(data.model ?? null);
      } catch (e) {
        setModelErr((e as Error).message);
      }
    })();
  }, [dataset, datasetId, t]);

  const builtLayers = (['bronze', 'silver', 'gold'] as Layer[]).filter((l) => dataset.versions[l].built);
  const metricReady = isMetricReady(dataset);

  return (
    <div style={{ marginTop: 4 }}>
      {/* 1 ── Medallion FQNs */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">{t('builder.dev.fqns')}</div>
        {builtLayers.length > 0 ? (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {builtLayers.map((l) => {
              const fqn = physicalFqn(dataset, l);
              const art = dataset.versions[l].artifact;
              return (
                <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span className="chip" style={{ textTransform: 'capitalize', minWidth: 56 }}>{layerWord(l, t)}</span>
                  <code className="mono" style={{ fontSize: 11, flex: 1, wordBreak: 'break-all' }}>{fqn}</code>
                  {art ? <span className="muted" style={{ fontSize: 11 }}>→ {art}</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            {t('builder.dev.noLayer')}
          </p>
        )}
      </div>

      {/* 1b ── Lineage — refinement + consumption chain + the transparency gate. Moved
          out of the (simplified) Edit surface into the Developer view, where the raw
          technical picture belongs. */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">{t('builder.dev.lineage')}</div>
        <LineagePanel datasetId={datasetId} />
      </div>

      {/* 2 ── dbt SQL artifacts */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">{t('builder.dev.sql')}</div>
        {sqlErr ? <div className="error" style={{ marginTop: 8 }}>{sqlErr}</div> : null}
        {sqlFiles.length > 0 ? (
          sqlFiles.map(({ path, content }) => (
            <div key={path} style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{path}</div>
              <pre className="codeblock" style={{ fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>
                {content || t('builder.dev.empty')}
              </pre>
            </div>
          ))
        ) : (
          <p className="hint" style={{ marginTop: 8 }}>
            {sqlErr ? null : t('builder.dev.noSql')}
          </p>
        )}
      </div>

      {/* 3 ── Metric model YAML */}
      <div className="grant-block" style={{ marginBottom: 16 }}>
        <div className="comp-label">{t('builder.dev.metricYaml')}</div>
        {modelErr ? <div className="error" style={{ marginTop: 8 }}>{modelErr}</div> : null}
        {metricReady && metricYaml ? (
          <pre className="codeblock" style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
            {metricYaml}
          </pre>
        ) : metricReady && !modelErr ? (
          <p className="hint" style={{ marginTop: 8 }}>
            {t('builder.dev.pending')}
          </p>
        ) : !metricReady ? (
          <p className="hint" style={{ marginTop: 8 }}>
            {dataset.tier === 'dataset' ? t('builder.dev.notAvailablePersonal') : t('builder.dev.notAvailableGold')}
          </p>
        ) : null}
      </div>

      {/* 4 ── Governance / RLS summary */}
      <div className="grant-block">
        <div className="comp-label">{t('builder.dev.governance')}</div>
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13 }}>
          <span className="muted">{t('builder.dev.tier')}</span>
          <span><span className={`badge ${TIER_BADGE[dataset.tier]}`}>{t(TIER_WORD[dataset.tier])}</span></span>
          <span className="muted">{t('builder.dev.visibility')}</span>
          <span>{visWord(dataset.visibility, t)}</span>
          <span className="muted">{t('builder.dev.owner')}</span>
          <span className="mono" style={{ fontSize: 12 }}>{dataset.owner}</span>
          <span className="muted">{t('builder.dev.domain')}</span>
          <span>{dataset.domain}</span>
          <span className="muted">{t('builder.dev.metricReady')}</span>
          <span>{metricReady ? <span className="status-chip s-searchable" style={{ cursor: 'default' }}>{t('builder.dev.yes')}</span> : <span className="status-chip s-stored" style={{ cursor: 'default' }}>{t('builder.dev.no')}</span>}</span>
          {dataset.certification ? (
            <>
              <span className="muted">{t('builder.dev.certified')}</span>
              <span>{t.rich('builder.dev.certifiedBy', { level: dataset.certification.level, by: dataset.certification.by, date: formatDate(dataset.certification.at, f), badge: (c) => <span className={`badge cert-${dataset.certification!.level}`}>{c}</span> })}</span>
            </>
          ) : null}
          {dataset.columns.length > 0 ? (
            <>
              <span className="muted">{t('builder.dev.columns')}</span>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-word' }}>
                {dataset.columns.map((c) => c.name).filter(Boolean).join(' · ') || '—'}
              </span>
            </>
          ) : null}
          {dataset.measures.length > 0 ? (
            <>
              <span className="muted">{t('builder.dev.measures')}</span>
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
