/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';
import LineagePanel from './LineagePanel';
import RefinePanel from './RefinePanel';
import GoldJoinPanel from './GoldJoinPanel';
import ExplorePanel from './ExplorePanel';
import BronzePanel from './BronzePanel';
import MetricsPanel from './MetricsPanel';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import DomainTag from '@/components/DomainTag';
import type { Visibility } from '@/lib/core/lifecycle';

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

/** "Show the code" — the same Forgejo-versioned files the panels + agent edit.
 *  Inlined from DatasetStepper so the dbt SQL editor lives in the detail. */
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
          {editable ? 'dataset.yaml is the single source — edit here, the tiles + stepper follow.' : 'Build materialises this native file; edit via the guided panel or the data agent.'}
          {savedNote ? <span className="ok-note"> {savedNote}</span> : null}
        </div>
        {editable ? <button className="btn" onClick={save}>Save</button> : null}
      </div>
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}

/**
 * Dataset detail panel — the "look at and document this dataset" surface.
 * Surfaces materialization status, tier/visibility, Cube readiness, and published
 * state as honest status chips; lets the owner edit description + column docs and
 * add data-quality check intentions; exposes all build + governance actions inline.
 *
 * Section order (top → bottom):
 *   Header (name + badges + provenance)
 *   Status chips
 *   Data preview
 *   Explore / profile
 *   Lineage
 *   Documentation  [Edit]
 *   Data quality   [Add rule inline]
 *   Metrics (governed Gold assets)
 *   Bring in data — Bronze  [expand/collapse]
 *   Configuration — dbt SQL / dataset.yaml  [Show/hide]
 *   Sharing / promotion
 *   Bottom action row: Silver build | Gold build | LifecycleActions (Archive/Delete)
 */
export default function DatasetDetail({
  datasetId,
  onBack,
  onOpenStepper: _onOpenStepper,
}: {
  datasetId: string;
  onBack: () => void;
  /** Kept for interface compat with DataTab — the "Advanced Build Rail" button
   *  is gone; all build actions are now inline in this detail. */
  onOpenStepper: (id: string) => void;
}) {
  const { user } = useUser();
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [checks, setChecks] = useState<DataCheck[]>([]);
  const [loadErr, setLoadErr] = useState('');
  // Catalog handshake (folded into the detail — there is no separate Catalog tab):
  // the OpenMetadata deep link for this dataset's governed entity, when present.
  const [omUrl, setOmUrl] = useState<string | null>(null);

  // ---- docs editing ----
  const [editingDocs, setEditingDocs] = useState(false);
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

  // ---- row preview (governed SELECT * LIMIT 50) ----
  const [preview, setPreview] = useState<RowPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState('');

  // ---- build flows (bottom action row) ----
  // 'bronze' → inline BronzePanel; 'silver' → RefinePanel; 'gold' → GoldJoinPanel.
  const [flow, setFlow] = useState<'bronze' | 'silver' | 'gold' | null>(null);

  // ---- configuration drawer (dbt SQL / dataset.yaml) ----
  const [showCode, setShowCode] = useState(false);

  // ---- sharing / promotion (mirrors Files: gate hint + button + request status) ----
  const [promote, setPromote] = useState<PromoteStatus | null>(null);
  // A pending certification request (asset → marketplace), from the certify route.
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

  // Sharing gate + in-flight request — the SAME source the Promote panel uses, so
  // the button here is gated (disabled until green) and shows any pending request.
  const loadPromote = useCallback(async () => {
    try {
      const [pRes, cRes] = await Promise.all([
        fetch(`/api/data/datasets/${datasetId}/promote`, { cache: 'no-store' }),
        fetch(`/api/data/datasets/${datasetId}/certify`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPromote(await pRes.json());
      if (cRes.ok) setCertifyPending((await cRes.json()).request?.status === 'pending');
    } catch { /* sharing status is best-effort; the detail stands without it */ }
  }, [datasetId]);
  useEffect(() => { loadPromote(); }, [loadPromote]);

  // Creator/Builder file a promotion REQUEST (a different Builder approves in
  // Governance — you can't promote your own; the server enforces this too).
  const requestPromote = useCallback(async () => {
    setShareErr(''); setShareBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const data = await res.json();
      if (!res.ok) { setShareErr(data.error ?? 'Could not request promotion'); return; }
      await Promise.all([loadPromote(), load()]);
    } catch (e) { setShareErr((e as Error).message); } finally { setShareBusy(false); }
  }, [datasetId, loadPromote, load]);

  // An Admin certifies a Shared asset to the marketplace directly; a Creator/Builder
  // files a certification request for an Admin to approve.
  const certifyAsset = useCallback(async (mode: 'certify' | 'request') => {
    setShareErr(''); setShareBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/certify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: mode }),
      });
      const data = await res.json();
      if (!res.ok) { setShareErr(data.error ?? 'Could not certify'); return; }
      await Promise.all([loadPromote(), load()]);
    } catch (e) { setShareErr((e as Error).message); } finally { setShareBusy(false); }
  }, [datasetId, loadPromote, load]);

  // Best-effort: surface this dataset's OpenMetadata entry (deep link) from the
  // catalog union. A missing catalog/OM never blocks the detail view.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/catalog', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { assets?: { datasetId?: string; omUrl?: string }[] };
        const hit = (data.assets ?? []).find((a) => a.datasetId === datasetId && a.omUrl);
        if (!cancelled && hit?.omUrl) setOmUrl(hit.omUrl);
      } catch { /* catalog offline — the detail stands on the registry alone */ }
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
      setEditingDocs(false);
    } catch (e) {
      setDocsErr((e as Error).message);
    } finally {
      setDocsBusy(false);
    }
  }, [datasetId, desc, cols]);

  const addRule = useCallback(async () => {
    const column = ruleColumn.trim();
    if (!column) { setChecksErr('Pick a column for the rule.'); return; }
    setChecksErr(''); setChecksBusy(true);
    const payload: Record<string, unknown> = { rule: ruleKind, column };
    if (ruleKind === 'accepted_values') {
      payload.values = ruleValues.split(',').map((v) => v.trim()).filter(Boolean);
    }
    if (ruleKind === 'range') {
      if (ruleMin.trim() !== '') payload.min = Number(ruleMin);
      if (ruleMax.trim() !== '') payload.max = Number(ruleMax);
    }
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setChecksErr(data.error ?? 'Could not add rule'); return; }
      setChecks((prev) => [...prev, data.check]);
      setRuleColumn(''); setRuleValues(''); setRuleMin(''); setRuleMax('');
    } catch (e) {
      setChecksErr((e as Error).message);
    } finally {
      setChecksBusy(false);
    }
  }, [datasetId, ruleKind, ruleColumn, ruleValues, ruleMin, ruleMax]);

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
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [datasetId]);

  // Governed 50-row preview: the SAME OPA-checked read path the profile/ask surfaces
  // use (GET .../preview → queryRun(SELECT * … LIMIT 50, principal)). We never build or
  // send SQL from the client; the server resolves the tier-aware FQN and applies masks/
  // row filters. A denied or unbuilt read comes back as a calm available:false state.
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

  // Auto-load the row preview whenever a dataset detail opens (and on dataset switch);
  // the button below is then just a manual "Refresh preview".
  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

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
  // Certification (asset → marketplace) is Admin-only; only an Admin certifies directly.
  const isAdmin = user?.role === 'admin';

  const builtLayers = (['bronze', 'silver', 'gold'] as Layer[]).filter((l) => dataset.versions[l].built);
  const colNames = dataset.columns.map((c) => c.name).filter(Boolean);
  // Build gating (Bronze → Silver → Gold, each layer unlocks the next):
  const canRefineSilver = dataset.versions.bronze.built;
  const canHarmonizeGold = dataset.versions.silver.built;
  // A guided build committed → close the flow and reload the honest built state.
  const onFlowCommitted = () => { setFlow(null); void load(); };

  return (
    <ConfirmProvider>
      {/* ── Nav ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn ghost" onClick={onBack}>← Datasets</button>
      </div>

      {/* ── Header ── */}
      <div className="stepper-head">
        <h2 className="stepper-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
          {dataset.name}
        </h2>
        <span className={`badge ${TIER_BADGE[dataset.tier]}`}>{TIER_WORD[dataset.tier]}</span>
        <span className="muted" style={{ fontSize: 13 }}>{dataset.owner} · {dataset.domain}</span>
        {/* Source-domain provenance for cross-domain (Shared asset / Marketplace product) views. */}
        {dataset.tier !== 'dataset' ? <DomainTag domain={dataset.domain} /> : null}
      </div>

      {/* ── Status chips ── */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {/* Materialization */}
        {layer ? (
          <span
            className="status-chip s-searchable"
            title={`Physical table: ${fqn}`}
            style={{ cursor: 'default' }}
          >
            ✓ materialized · {layer} · <span className="mono" style={{ fontSize: 10 }}>{fqn}</span>
          </span>
        ) : (
          <span
            className="status-chip s-stored"
            title="No medallion layer built yet — use Bring in data below to upload a file or pull an extract"
            style={{ cursor: 'default' }}
          >
            not materialized — no layer built yet
          </span>
        )}

        {/* Tier / visibility */}
        <span
          className={`badge ${TIER_BADGE[dataset.tier]}`}
          style={{ alignSelf: 'center' }}
          title={`Tier: ${dataset.tier} · Visibility: ${dataset.visibility}`}
        >
          {VIS_WORD[dataset.visibility] ?? dataset.visibility}
        </span>

        {/* Cube semantic layer */}
        {cubeReady ? (
          <span
            className="status-chip s-searchable"
            title="This dataset's Gold table is governed and built — the Cube model sync can deliver it to the semantic layer"
            style={{ cursor: 'default' }}
          >
            ✓ Cube model ready
          </span>
        ) : (
          <span
            className="status-chip s-stored"
            title={dataset.tier === 'dataset'
              ? 'Cube model: promote to a data asset and build Gold first'
              : 'Cube model: build the Gold layer first'}
            style={{ cursor: 'default' }}
          >
            Cube model not ready
          </span>
        )}

        {/* Catalog (OpenMetadata) deep link — the catalog lives IN the detail now. */}
        {omUrl ? (
          <a
            className="status-chip s-searchable"
            href={omUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this dataset's entity in the OpenMetadata catalog"
          >
            catalog · OpenMetadata ↗
          </a>
        ) : null}

        {/* Published / certified */}
        {published ? (
          <span
            className={`badge cert-${dataset.certification!.level}`}
            title={`Certified ${dataset.certification!.level} by ${dataset.certification!.by} on ${formatDate(dataset.certification!.at)}`}
            style={{ cursor: 'default' }}
          >
            ✓ certified data product · {dataset.certification!.level}
          </span>
        ) : (
          <span
            className="status-chip s-stored"
            title={dataset.tier === 'product' ? 'Certification badge present' : 'Not yet a certified data product'}
            style={{ cursor: 'default' }}
          >
            not published
          </span>
        )}
      </div>

      {/* ── Data preview (governed SELECT * LIMIT 50) ── */}
      <div className="section-title" style={{ marginTop: 4 }}>
        Data preview
        <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={loadPreview} disabled={previewing}>
          {previewing ? <span className="spin" /> : 'Refresh preview'}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
        A read-only scan of the first 50 rows through the governed query path (Trino,
        OPA-checked) — your row filters and column masks apply, exactly as the agents and
        dashboards see it. Nothing is previewed until a layer is built.
      </p>
      {previewErr ? <div className="error" style={{ marginBottom: 10 }}>{previewErr}</div> : null}
      {preview ? (
        preview.available ? (
          <>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
              First {preview.rowCount} row{preview.rowCount === 1 ? '' : 's'} · {preview.layer}
              {' · '}<span className="mono" style={{ fontSize: 10 }}>{preview.fqn}</span>
            </p>
            {preview.columns.length > 0 ? (
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table>
                  <thead>
                    <tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>No rows to show.</p>
            )}
          </>
        ) : (
          <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>{preview.reason}</p>
        )
      ) : null}

      {/* ── Explore (quiet profile of a built version — governed reads, masked) ── */}
      {builtLayers.length > 0 ? (
        <>
          <div className="section-title" style={{ marginTop: 20 }}>Explore</div>
          {/* The row preview lives ONCE in the "Data preview" section above — Explore
              here shows the profile only, so the same rows aren't rendered twice. */}
          <ExplorePanel datasetId={dataset.id} builtLayers={builtLayers} showPreview={false} />
        </>
      ) : null}

      {/* ── Lineage (refinement + consumption chain, from the single source) ── */}
      <div className="section-title" style={{ marginTop: 20 }}>Lineage</div>
      <LineagePanel datasetId={dataset.id} />

      {/* ── Documentation ── */}
      <div className="section-title" style={{ marginTop: 20 }} {...anchorAttr(ANCHORS.data.document)}>
        Documentation
        {!editingDocs && canEdit ? (
          <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={() => { setEditingDocs(true); setDocsOk(''); }}>
            Edit
          </button>
        ) : null}
        {docsOk && !editingDocs ? <span className="ok-note" style={{ marginLeft: 10, fontSize: 12.5 }}>{docsOk}</span> : null}
      </div>

      {editingDocs && canEdit ? (
        <div className="guided-panel" style={{ marginBottom: 16 }}>
          <label className="muted" style={{ fontSize: 12.5 }}>What is this dataset?</label>
          <textarea
            rows={2}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="One line a teammate in another domain would understand."
          />
          <div className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>Column meanings</div>
          {cols.map((c, i) => (
            <div className="row" key={i} style={{ gap: 8, marginBottom: 6 }}>
              <input
                style={{ maxWidth: 180 }}
                placeholder="column"
                value={c.name}
                onChange={(e) => setCols((cs) => cs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
              />
              <input
                style={{ flex: 1 }}
                placeholder="what it means"
                value={c.description}
                onChange={(e) => setCols((cs) => cs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
              />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setCols((cs) => cs.filter((_, j) => j !== i))}
                aria-label="Remove column"
              >×</button>
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => setCols((cs) => [...cs, { name: '', description: '' }])}>+ Column</button>
          {docsErr ? <div className="error" style={{ marginTop: 8 }}>{docsErr}</div> : null}
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn" onClick={saveDocs} disabled={docsBusy}>
              {docsBusy ? <span className="spin" /> : 'Save'}
            </button>
            <button className="btn ghost" onClick={() => { setEditingDocs(false); setDocsErr(''); }}>Cancel</button>
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
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {dataset.columns.map((c) => (
                    <tr key={c.name}>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{c.name}</td>
                      <td className="muted" style={{ whiteSpace: 'normal' }}>{c.description || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: '0 0 16px' }}>
              No column docs yet.{canEdit ? ' Click Edit above to add them.' : ''}
            </p>
          )}
        </>
      )}

      {/* ── Data quality ── */}
      <div className="section-title" style={{ marginTop: 4 }}>
        Data quality
        <span className="count-pill">{checks.length}</span>
        {badge ? (
          <span
            className={`badge ${badge === 'passing' ? 'vis-shared' : badge === 'failing' ? 'vis-personal' : ''}`}
            style={{ marginLeft: 10 }}
            title={ranAt ? `Last run ${formatDate(ranAt)}` : undefined}
          >
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
        Dropdown rules run through the governed query path (as the owner) against this
        dataset&apos;s built table — a real pass/fail per rule. A rule that can&apos;t run
        (nothing materialised yet) shows &ldquo;not run&rdquo;, never a fake pass.
        {' '}Full dbt-core tests are the next step; this is the governed-SQL bridge.
      </p>
      {runErr ? <div className="error" style={{ marginBottom: 10 }}>{runErr}</div> : null}

      {checks.length > 0 ? (
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Result</th>
                <th>Added by</th>
                {canEdit ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {checks.map((chk) => {
                const r = results[chk.id];
                return (
                  <tr key={chk.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{ruleText(chk)}</td>
                    <td>
                      {r ? (
                        r.status === 'pass' ? (
                          <span className="status-chip s-searchable" style={{ cursor: 'default' }}>✓ pass</span>
                        ) : r.status === 'fail' ? (
                          <span className="status-chip s-stored" style={{ cursor: 'default' }} title={`${r.violations} violating row(s)`}>
                            ✗ fail · {r.violations}
                          </span>
                        ) : (
                          <span className="muted" title={r.reason}>not run</span>
                        )
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">{chk.createdBy}</td>
                    {canEdit ? (
                      <td>
                        <button className="btn ghost sm" onClick={() => deleteRule(chk.id)} aria-label="Remove rule">×</button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>No quality rules yet.</p>
      )}

      {canEdit ? (
        <div className="guided-panel" style={{ padding: '12px 16px' }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Add a rule</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={ruleKind} onChange={(e) => setRuleKind(e.target.value as DataCheckRule)} style={{ maxWidth: 170 }}>
              {(Object.keys(RULE_LABELS) as DataCheckRule[]).map((k) => (
                <option key={k} value={k}>{RULE_LABELS[k]}</option>
              ))}
            </select>
            {dataset.columns.length > 0 ? (
              <select value={ruleColumn} onChange={(e) => setRuleColumn(e.target.value)} style={{ maxWidth: 200 }}>
                <option value="">column…</option>
                {dataset.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            ) : (
              <input style={{ maxWidth: 200 }} placeholder="column" value={ruleColumn} onChange={(e) => setRuleColumn(e.target.value)} />
            )}
            {ruleKind === 'accepted_values' ? (
              <input
                style={{ flex: 1, minWidth: 160 }}
                placeholder="allowed values, comma-separated"
                value={ruleValues}
                onChange={(e) => setRuleValues(e.target.value)}
              />
            ) : null}
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

      {/* ── Metrics (defined measures — the Cube handover, governed Gold assets only) ── */}
      {dataset.measures.length > 0 || (dataset.tier !== 'dataset' && dataset.versions.gold.built) ? (
        <>
          <div className="section-title" style={{ marginTop: 20 }}>
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
                Metrics are defined on the <strong>governed</strong> Gold table (Cube reads the Trino mart).
                Share this dataset above first — then define metrics on the asset/product.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── Bring in data — Bronze ── */}
      {canEdit ? (
        <>
          <div className="section-title" style={{ marginTop: 20 }}>
            Bring in data
            <button
              className="btn ghost sm"
              style={{ marginLeft: 10 }}
              onClick={() => setFlow(flow === 'bronze' ? null : 'bronze')}
            >
              {flow === 'bronze' ? 'Close' : dataset.versions.bronze.built ? 'Re-upload / replace' : 'Upload or extract'}
            </button>
            {dataset.versions.bronze.built ? (
              <span className="status-chip s-searchable" style={{ cursor: 'default', marginLeft: 10 }}>✓ Bronze built</span>
            ) : null}
          </div>
          <p className="hint" style={{ marginTop: 0, marginBottom: flow === 'bronze' ? 10 : 14 }}>
            {dataset.versions.bronze.built
              ? 'Raw Bronze layer is in. Refine it into Silver using the action below.'
              : 'Upload a file or pull a masked extract from a governed product to create the raw Bronze layer.'}
          </p>
          {flow === 'bronze' ? (
            <div style={{ marginBottom: 14 }}>
              <BronzePanel
                datasetId={dataset.id}
                datasetName={dataset.name}
                onCommitted={onFlowCommitted}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── Configuration — dbt SQL / dataset.yaml ── */}
      {canEdit ? (
        <>
          <div className="section-title" style={{ marginTop: 4 }}>
            Configuration
            <button
              className={`btn ghost sm${showCode ? ' on' : ''}`}
              style={{ marginLeft: 10 }}
              onClick={() => setShowCode((v) => !v)}
            >
              {showCode ? 'Hide the code' : '‹ › Show the code'}
            </button>
          </div>
          {showCode ? (
            <div style={{ marginBottom: 14 }}>
              <p className="hint" style={{ marginTop: 0 }}>
                dataset.yaml is the single source — the tiles, build panels, and the data agent all read from and write to these files.
              </p>
              <CodeDrawer datasetId={dataset.id} />
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── Sharing / promotion (governed like Files: a Creator/Builder REQUESTS a
              promotion — a different Builder approves; an Admin certifies to the
              marketplace). Explicit, role-gated buttons — never a dead control. ── */}
      <div className="section-title" style={{ marginTop: 20 }}>Sharing</div>
      {dataset.tier === 'dataset' ? (
        canHarmonizeGold ? (
          // Refined past Bronze → shareable. Mirror FilePreview: pending wins; else a
          // gate hint + a button disabled until the transparency gate is green.
          <div className="gate-check" style={{ marginTop: 4 }}>
            <span className="badge vis-personal">Personal</span>{' '}
            {promote?.request?.status === 'pending' ? (
              <span className="muted" style={{ fontSize: 13 }}>
                Promotion requested — a domain <strong>Builder</strong> approves it in the{' '}
                <strong>Governance</strong> tab, which moves it into Trino.
              </span>
            ) : canEdit ? (
              <>
                <span className="muted" style={{ fontSize: 13 }}>
                  In your private space — only you can see it. Promote it to share with your domain.
                </span>
                {promote && !promote.gate.ok ? (
                  <div className="hint" style={{ margin: '6px 0 0' }}>To share, add {promote.gate.missing.join(', ')}.</div>
                ) : null}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" disabled={shareBusy || !!(promote && !promote.gate.ok)} onClick={requestPromote}
                    title={promote && !promote.gate.ok ? 'Complete the transparency gate first' : 'A domain Builder approves this and moves it into Trino'}>
                    {shareBusy ? <span className="spin" /> : 'Promote to Domain →'}
                  </button>
                </div>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>Private to {dataset.owner}.</span>
            )}
          </div>
        ) : (
          // Bronze-only: promotion to Shared is NOT available — mirror the server's
          // fail-closed rule (requestPromotion blocks Bronze) with a clear, calm hint.
          <div className="gate-check" style={{ marginTop: 4 }}>
            <span className="badge vis-personal">Personal</span>{' '}
            <span className="muted" style={{ fontSize: 13 }}>
              This raw <strong>Bronze</strong> dataset can&apos;t be shared yet —
              <strong> promote after refining to Silver/Gold</strong>.
              {canEdit ? <> Use <strong>Turn into clean Silver Dataset</strong> below to refine it first.</> : null}
            </span>
          </div>
        )
      ) : dataset.tier === 'asset' ? (
        <div className="gate-check gate-ok" style={{ marginTop: 4 }}>
          <span className="badge vis-shared">Domain</span>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            Promoted data asset in <strong>Trino/Iceberg</strong> ({dataset.domain} domain).
          </span>
          {certifyPending ? (
            <div className="hint" style={{ marginTop: 6 }}>
              Certification requested — a platform <strong>Admin</strong> approves it in the <strong>Governance</strong> tab.
            </div>
          ) : (
            <div className="row" style={{ marginTop: 8 }}>
              {isAdmin ? (
                <button className="btn" disabled={shareBusy} onClick={() => certifyAsset('certify')}
                  title="Certify this asset as a data product and list it in the marketplace">
                  {shareBusy ? <span className="spin" /> : 'Certify to Company →'}
                </button>
              ) : canEdit ? (
                <button className="btn ghost" disabled={shareBusy} onClick={() => certifyAsset('request')}
                  title="Ask a platform Admin to certify this as a marketplace data product">
                  {shareBusy ? <span className="spin" /> : 'Request certification →'}
                </button>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>An Admin certifies it as a marketplace data product.</span>
              )}
            </div>
          )}
        </div>
      ) : dataset.tier === 'product' ? (
        <div className="gate-check gate-ok" style={{ marginTop: 4 }}>
          <span className="badge vis-certified">Company</span>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            Certified data product — discoverable across the marketplace.
          </span>
        </div>
      ) : null}
      {shareErr ? <div className="error" style={{ marginTop: 8 }}>{shareErr}</div> : null}

      {/* ── Bottom action row ──
           The three primary build CTAs + lifecycle. Bronze→Silver / Silver→Gold gating
           preserved: show the right button for the current layer; disabled/hint when not
           applicable. The flow panels expand inline just above this row. */}
      {canEdit ? (
        <div style={{ marginTop: 32, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
          {/* Inline flow panels — expand above the action row */}
          {flow === 'silver' && canRefineSilver ? (
            <div style={{ marginBottom: 16 }}>
              <div className="section-title" style={{ marginTop: 0 }}>
                Clean it up — Silver
                <span className="hint" style={{ margin: '0 0 0 10px' }}>dbt transformations on your Bronze data</span>
              </div>
              <RefinePanel
                datasetId={dataset.id}
                datasetName={dataset.name}
                owner={dataset.owner}
                domain={dataset.domain}
                tier={dataset.tier}
                columns={colNames}
                stage={{ layer: 'silver', copy: { title: 'Clean it up', subtitle: '', tool: '' } }}
                onCommitted={onFlowCommitted}
              />
            </div>
          ) : null}

          {flow === 'gold' && canHarmonizeGold ? (
            <div style={{ marginBottom: 16 }}>
              <div className="section-title" style={{ marginTop: 0 }}>
                Harmonize — Gold
                <span className="hint" style={{ margin: '0 0 0 10px' }}>join trusted datasets into one governed Gold table</span>
              </div>
              <GoldJoinPanel
                datasetId={dataset.id}
                datasetName={dataset.name}
                owner={dataset.owner}
                domain={dataset.domain}
                tier={dataset.tier}
                columns={colNames}
                onCommitted={onFlowCommitted}
              />
            </div>
          ) : null}

          {/* Action buttons */}
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Bronze → Silver */}
            {canRefineSilver ? (
              <button
                className={`btn${flow === 'silver' ? ' ghost' : ''}`}
                onClick={() => setFlow(flow === 'silver' ? null : 'silver')}
              >
                {flow === 'silver'
                  ? 'Close Silver build'
                  : dataset.versions.silver.built
                    ? 'Re-clean the Silver version'
                    : 'Turn into clean Silver Dataset'}
              </button>
            ) : (
              <button className="btn" disabled title="Bring in a Bronze layer first (use Bring in data above)">
                Turn into clean Silver Dataset
              </button>
            )}

            {/* Silver → Gold */}
            {canHarmonizeGold ? (
              <button
                className={`btn${flow === 'gold' ? ' ghost' : ''}`}
                onClick={() => setFlow(flow === 'gold' ? null : 'gold')}
              >
                {flow === 'gold'
                  ? 'Close Gold build'
                  : dataset.versions.gold.built
                    ? 'Re-harmonize the Gold version'
                    : 'Turn into harmonized Gold dataset'}
              </button>
            ) : (
              <button className="btn ghost" disabled title="Clean it to Silver first, then you can harmonize into Gold">
                Turn into harmonized Gold dataset
              </button>
            )}

            {/* Archive / Restore / Delete — OS-wide lifecycle. Only an archived
                dataset exposes Delete. Real archived state drives it. */}
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
          </div>
        </div>
      ) : null}
    </ConfirmProvider>
  );
}
