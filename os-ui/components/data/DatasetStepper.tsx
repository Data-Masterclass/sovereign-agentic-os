/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import BronzePanel from './BronzePanel';
import RefinePanel from './RefinePanel';
import PromotePanel from './PromotePanel';
import CertifyPanel from './CertifyPanel';
import MetricsPanel from './MetricsPanel';
import LineagePanel from './LineagePanel';

type Layer = 'bronze' | 'silver' | 'gold';
type Stage = {
  layer: Layer;
  copy: { title: string; subtitle: string; tool: string };
  built: boolean;
  passThrough: boolean;
  quality: 'unknown' | 'passing' | 'failing';
  updatedAt: string | null;
  artifact: string | null;
  buildable: boolean;
};
type ColumnDoc = { name: string; description: string };
type Dataset = {
  id: string; name: string; tier: 'dataset' | 'asset' | 'product';
  owner: string; domain: string; visibility: string;
  description: string; columns: ColumnDoc[];
};

const TIER_BADGE: Record<Dataset['tier'], string> = { dataset: 'vis-personal', asset: 'vis-shared', product: 'vis-certified' };
const TIER_WORD: Record<Dataset['tier'], string> = { dataset: 'Dataset', asset: 'Data asset', product: 'Data product' };

function freshLabel(iso: string | null): string {
  if (!iso) return 'not built yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'recently';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
}


/** "Show the code" — the same Forgejo-versioned files the panels + agent edit. */
function CodeDrawer({ datasetId }: { datasetId: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState('dataset.yaml');
  const [content, setContent] = useState('');
  const [sha, setSha] = useState('');
  const [err, setErr] = useState('');
  const [savedNote, setSavedNote] = useState('');

  const load = useCallback(async (p: string) => {
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
      if (res.ok) { setFiles(data.files ?? []); load('dataset.yaml'); }
    })();
  }, [datasetId, load]);

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
          <button key={f} className={`chip${f === path ? ' on' : ''}`} style={{ cursor: 'pointer' }} onClick={() => load(f)}>{f}</button>
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

export default function DatasetStepper({ datasetId, onBack }: { datasetId: string; onBack: () => void }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [openStage, setOpenStage] = useState<Layer | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not open dataset'); return; }
      setDataset(data.dataset); setStages(data.stages ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, [datasetId]);
  useEffect(() => { load(); }, [load]);

  const onCommitted = useCallback((next: Stage[]) => { setStages(next); setOpenStage(null); load(); }, [load]);

  if (err) return <><button className="btn ghost" onClick={onBack}>← All datasets</button><div className="error" style={{ marginTop: 14 }}>{err}</div></>;
  if (!dataset) return <div className="stub-page">Opening dataset…</div>;

  const active = openStage ? stages.find((s) => s.layer === openStage) ?? null : null;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn ghost" onClick={onBack}>← All datasets</button>
        <button className={`btn ghost${showCode ? ' on' : ''}`} onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Hide the code' : '‹ › Show the code'}
        </button>
      </div>

      <div className="stepper-head">
        <h2 className="stepper-name">{dataset.name}</h2>
        <span className={`badge ${TIER_BADGE[dataset.tier]}`}>{TIER_WORD[dataset.tier]}</span>
        <span className="muted">{dataset.owner} · {dataset.domain}</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        One dataset, three versions of itself. Double-click a step to build it — each is guided and previewed before it commits.
      </p>

      {showCode ? <CodeDrawer datasetId={datasetId} /> : null}

      <div className="stepper-rail">
        {stages.map((s, i) => (
          <div key={s.layer} className="stepper-step-wrap">
            {i > 0 ? <div className={`stepper-link${stages[i - 1].built ? ' done' : ''}`} /> : null}
            <button
              type="button"
              className={`stepper-step ${s.layer}${s.built ? ' built' : ''}${openStage === s.layer ? ' open' : ''}${!s.buildable ? ' locked' : ''}`}
              onDoubleClick={() => { if (s.buildable) setOpenStage(s.layer); }}
              onClick={() => { if (s.buildable && s.built) setOpenStage(s.layer); }}
              title={s.buildable ? 'Double-click to build / open' : 'Bring in the previous version first'}
            >
              <span className="step-layer">{s.layer}</span>
              <span className="step-title">{s.copy.title}</span>
              <span className="step-state">
                {s.built ? (s.passThrough ? 'passed through' : `built · ${freshLabel(s.updatedAt)}`) : s.buildable ? 'ready to build' : 'locked'}
              </span>
              {s.built ? <span className={`quality-badge q-${s.quality}`}>{s.quality === 'passing' ? '✓' : s.quality === 'failing' ? '✗' : '—'}</span> : null}
            </button>
          </div>
        ))}
      </div>

      {active ? (
        <div className="stage-open">
          <div className="section-title" style={{ marginTop: 18 }}>
            {active.copy.title}<span className="count-pill">{active.layer}</span>
            <span className="hint" style={{ margin: 0 }}>{active.copy.subtitle}</span>
          </div>
          {active.layer === 'bronze'
            ? <BronzePanel datasetId={dataset.id} datasetName={dataset.name} onCommitted={(s) => onCommitted(s as Stage[])} />
            : <RefinePanel datasetId={dataset.id} datasetName={dataset.name}
                stage={{ layer: active.layer as 'silver' | 'gold', copy: active.copy }}
                onCommitted={(s) => onCommitted(s as Stage[])} />}
        </div>
      ) : null}

      {/* Share → promote (Builder-approved) → certify (Admin) → marketplace. */}
      <div className="section-title" style={{ marginTop: 22 }}>Share</div>
      {dataset.tier === 'dataset' ? (
        <PromotePanel
          datasetId={dataset.id}
          owner={dataset.owner}
          domain={dataset.domain}
          tier={dataset.tier}
          initialDescription={dataset.description}
          initialColumns={dataset.columns}
          onChanged={load}
        />
      ) : (
        <CertifyPanel
          datasetId={dataset.id}
          owner={dataset.owner}
          domain={dataset.domain}
          onChanged={load}
        />
      )}

      {/* Metrics + dashboards — defined on the GOVERNED Gold version (Cube reads Trino). */}
      {stages.find((s) => s.layer === 'gold')?.built ? (
        <>
          <div className="section-title" style={{ marginTop: 22 }}>Metrics &amp; dashboards</div>
          {dataset.tier === 'dataset' ? (
            <div className="guided-panel">
              <p className="muted" style={{ marginTop: 0 }}>
                Metrics are defined on the <strong>governed</strong> Gold table (Cube reads the Trino mart).
                Share this dataset above first — then define metrics on the asset/product.
              </p>
            </div>
          ) : (
            <MetricsPanel datasetId={dataset.id} />
          )}
        </>
      ) : null}

      {/* Lineage + transparency — end-to-end, both axes, enforced on every Build. */}
      {stages.some((s) => s.built) ? (
        <>
          <div className="section-title" style={{ marginTop: 22 }}>Lineage &amp; transparency</div>
          <LineagePanel datasetId={dataset.id} />
        </>
      ) : null}
    </>
  );
}
