/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import LineagePanel from './LineagePanel';
import RefinePanel from './RefinePanel';
import GoldJoinPanel from './GoldJoinPanel';
import ExplorePanel from './ExplorePanel';
import BronzePanel from './BronzePanel';
import MetricsPanel from './MetricsPanel';
import StageAssistant, { type DefineDraft } from './StageAssistant';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import DomainTag from '@/components/DomainTag';
import type { Visibility } from '@/lib/core/lifecycle';
import StageShell from '@/components/core/StageShell';
import { initialStageState, markDone, type StageState } from '@/lib/core/stages';
import { DATA_STAGES, type DataStageId, type DataCtx } from '@/lib/data/stages';

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
  owner: string;
  domain: string;
  tier: 'dataset' | 'asset' | 'product';
  visibility: string;
  description: string;
  versions: { bronze: VersionState; silver: VersionState; gold: VersionState };
  columns: ColumnDoc[];
  measures: { name: string }[];
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

function furthestBuilt(versions: Dataset['versions']): Layer | null {
  if (versions.gold.built) return 'gold';
  if (versions.silver.built) return 'silver';
  if (versions.bronze.built) return 'bronze';
  return null;
}

/** Tier-aware physical FQN — mirrors the server's builtLayerFqn: a personal dataset
 *  lives in the OWNER's `personal_<uid>` schema, a governed one in its (sanitized)
 *  domain schema. Never shows a table name that can't exist. */
function physicalFqn(d: Dataset, layer: Layer): string {
  const schema = d.tier === 'dataset' ? `personal_${slug(d.owner)}` : slug(d.domain);
  return `iceberg.${schema}.${layer}_${slug(d.name)}`;
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

const TIER_BADGE: Record<Dataset['tier'], string> = { dataset: 'vis-personal', asset: 'vis-shared', product: 'vis-certified' };
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
  // ---- health score + persisted trend + profile-driven suggestions (Validate) ----
  const [health, setHealth] = useState<HealthScore | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedCheck[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [acceptingAll, setAcceptingAll] = useState(false);

  // ---- row preview (governed SELECT * LIMIT 50) ----
  const [preview, setPreview] = useState<RowPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState('');

  // ---- configuration drawer (dbt SQL / dataset.yaml) ----
  const [showCode, setShowCode] = useState(false);

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

  return (
    <ConfirmProvider>
      <button className="btn ghost" onClick={onBack} style={{ marginBottom: 14 }}>← Datasets</button>

      {/* ── Header + status chips (always visible, above the stepper) ── */}
      <div className="stepper-head">
        <h2 className="stepper-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
          {dataset.name}
        </h2>
        <span className={`badge ${TIER_BADGE[dataset.tier]}`}>{TIER_WORD[dataset.tier]}</span>
        <span className="muted" style={{ fontSize: 13 }}>{dataset.owner} · {dataset.domain}</span>
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

      <StageShell
        stages={DATA_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Dataset stages"
        assistant={(st) =>
          st.id === 'ingest' ? (
            <StageAssistant
              datasetId={dataset.id} stage="ingest"
              label="Explain an ingest error in plain language." cta="Explain the error"
              payload={() => ({ name: dataset.name, reason: previewErr || (preview && !preview.available ? preview.reason : '') })}
            />
          ) : st.id === 'define' ? (
            <StageAssistant
              datasetId={dataset.id} stage="define"
              label="Draft a description and column notes from the schema." cta="Draft docs"
              disabled={!canEdit}
              payload={() => ({ name: dataset.name, prompt: desc, columns: colNames.length ? colNames : cols.map((c) => c.name).filter(Boolean) })}
              onDraft={applyDraft}
            />
          ) : st.id === 'harmonize' ? (
            <StageAssistant
              datasetId={dataset.id} stage="harmonize"
              label={`"Clean/join for me" — a proposal, plus a CTAS-error explainer.`} cta="Propose a clean/join"
              payload={() => ({ name: dataset.name, columns: colNames })}
            />
          ) : st.id === 'validate' ? (
            <StageAssistant
              datasetId={dataset.id} stage="validate"
              label={suggestions.length ? 'Explain the checks suggested from the profile.' : 'Suggest quality rules for the documented columns.'}
              cta={suggestions.length ? 'Explain suggestions' : 'Suggest rules'}
              payload={() => ({
                name: dataset.name,
                columns: colNames,
                // When we have deterministic profile→rule suggestions, hand them to the
                // model as rendered lines so it explains WHY each matters (rationale layer).
                ...(suggestions.length ? { suggestions: suggestions.map((s) => `${suggestionText(s)} — ${s.evidence}`) } : {}),
              })}
            />
          ) : st.id === 'publish' ? (
            <StageAssistant
              datasetId={dataset.id} stage="publish"
              label="Suggest governed measures to define before you promote." cta="Suggest measures"
              payload={() => ({ name: dataset.name, columns: colNames, measures: dataset.measures.map((m) => m.name) })}
            />
          ) : null /* Talk to Data (in Publish) is its own governed NL→SQL surface, not the assistant slot */
        }
      >
        {/* ─────────────── Ingest ─────────────── */}
        {stage.current === 'ingest' ? (
          <div>
            {canEdit ? (
              <BronzePanel
                datasetId={dataset.id}
                datasetName={dataset.name}
                onCommitted={() => { onBuilt(); settle('ingest'); }}
              />
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>Only the owner and domain admins can bring in data.</p>
            )}

            {/* Raw preview of what landed — the governed SELECT * LIMIT 50. */}
            <div className="section-title" style={{ marginTop: 22 }}>
              Raw preview
              <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={loadPreview} disabled={previewing}>
                {previewing ? <span className="spin" /> : 'Refresh preview'}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              A read-only scan of the first 50 rows through the governed query path (Trino, OPA-checked). Nothing is previewed until a layer is built.
            </p>
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
          </div>
        ) : null}

        {/* ─────────────── Define ─────────────── */}
        {stage.current === 'define' ? (
          <div {...anchorAttr(ANCHORS.data.document)}>
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
                <div className="section-title" style={{ marginTop: 4 }}>
                  Clean it up — Silver
                  <span className="hint" style={{ margin: '0 0 0 10px' }}>dbt transformations on your Bronze data</span>
                </div>
                {canRefineSilver ? (
                  <RefinePanel
                    datasetId={dataset.id} datasetName={dataset.name}
                    owner={dataset.owner} domain={dataset.domain} tier={dataset.tier}
                    columns={colNames}
                    stage={{ layer: 'silver', copy: { title: 'Clean it up', subtitle: '', tool: '' } }}
                    onCommitted={() => { onBuilt(); settle('define'); }}
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
                <div className="section-title" style={{ marginTop: 0 }}>
                  Harmonize — Gold
                  <span className="hint" style={{ margin: '0 0 0 10px' }}>join trusted datasets into one governed Gold table</span>
                </div>
                {canHarmonizeGold ? (
                  <GoldJoinPanel
                    datasetId={dataset.id} datasetName={dataset.name}
                    owner={dataset.owner} domain={dataset.domain} tier={dataset.tier}
                    columns={colNames}
                    onCommitted={() => { onBuilt(); settle('harmonize'); }}
                  />
                ) : <p className="muted" style={{ fontSize: 13 }}>Clean it to Silver first (in Define), then you can harmonize into Gold.</p>}
              </>
            ) : <p className="muted" style={{ fontSize: 13 }}>Only the owner and domain admins can harmonize this dataset.</p>}

            {builtLayers.length > 0 ? (
              <>
                <div className="section-title" style={{ marginTop: 22 }}>Explore</div>
                <ExplorePanel datasetId={dataset.id} builtLayers={builtLayers} showPreview={false} />
              </>
            ) : null}
          </div>
        ) : null}

        {/* ─────────────── Validate ─────────────── */}
        {stage.current === 'validate' ? (
          <div>
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
                      return (
                        <tr key={chk.id}>
                          <td className="mono" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{ruleText(chk)}</td>
                          <td className="muted">{chk.createdBy}</td>
                          <td>
                            {r ? (
                              r.status === 'pass' ? <span className="status-chip s-searchable" style={{ cursor: 'default' }}>✓ pass</span>
                                : r.status === 'fail' ? <span className="status-chip s-stored" style={{ cursor: 'default' }} title={`${r.violations} violating row(s)`}>✗ fail · {r.violations}</span>
                                  : <span className="muted" title={r.reason}>not run</span>
                            ) : <span className="muted">—</span>}
                          </td>
                          {canEdit ? <td><button className="btn ghost sm" onClick={() => deleteRule(chk.id)} aria-label="Remove rule">×</button></td> : null}
                        </tr>
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

            {/* Lineage — refinement + consumption chain, moved here from the old Use stage. */}
            <div className="section-title" style={{ marginTop: 24 }}>Lineage</div>
            <LineagePanel datasetId={dataset.id} />
          </div>
        ) : null}

        {/* ─────────────── Publish (Metrics & Usage) ─────────────── */}
        {stage.current === 'publish' ? (
          <div>
            {/* Talk to Data — governed NL→SQL over what the viewer can see (usage before promote). */}
            <div {...anchorAttr(ANCHORS.data.query)}>
              <TalkTo tab="data" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
            </div>

            {/* Doorway — jump to Metrics or Dashboards pre-scoped to this dataset. */}
            {/* TODO: pass ?dataset=<id> once Metrics/Dashboards pages read that param to pre-scope. */}
            <div className="section-title" style={{ marginTop: 24 }}>Build on this data</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Take the next step — define a metric or build a dashboard on top of this dataset.
            </p>
            <div className="row" style={{ gap: 10 }}>
              <a className="btn ghost" href="/metrics" title="Define a metric on this dataset in the Metrics tab">
                Build a metric →
              </a>
              <a className="btn ghost" href="/dashboards" title="Build a dashboard using this dataset in the Dashboards tab">
                Build a dashboard →
              </a>
            </div>

            {/* Metrics — defined on the governed Gold asset (Cube handover). */}
            {dataset.measures.length > 0 || (dataset.tier !== 'dataset' && dataset.versions.gold.built) ? (
              <>
                <div className="section-title" style={{ marginTop: 0 }}>
                  Metrics
                  {dataset.measures.length > 0 ? <span className="count-pill">{dataset.measures.length}</span> : null}
                </div>
                {dataset.measures.length > 0 ? (
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    {dataset.measures.map((m) => <span className="chip" key={m.name}>{m.name}</span>)}
                  </div>
                ) : null}
                {dataset.tier !== 'dataset' && dataset.versions.gold.built ? (
                  <MetricsPanel datasetId={dataset.id} />
                ) : dataset.tier === 'dataset' && dataset.versions.gold.built ? (
                  <div className="guided-panel" style={{ marginBottom: 12 }}>
                    <p className="muted" style={{ marginTop: 0 }}>
                      Metrics are defined on the <strong>governed</strong> Gold table (Cube reads the Trino mart). Promote this dataset below first — then define metrics on the asset/product.
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}

            {/* Configuration drawer (dbt SQL / dataset.yaml). */}
            {canEdit ? (
              <>
                <div className="section-title" style={{ marginTop: 20 }}>
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

            {/* Sharing / promotion — the governed promote/certify block. */}
            <div className="section-title" style={{ marginTop: 20 }}>Sharing</div>
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
          </div>
        ) : null}
      </StageShell>
    </ConfirmProvider>
  );
}
