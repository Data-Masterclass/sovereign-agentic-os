/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';

type Layer = 'bronze' | 'silver' | 'gold';
type VersionState = { built: boolean; updatedAt: string | null; artifact: string | null };
type ColumnDoc = { name: string; description: string };
type DataCheck = { id: string; name: string; description: string; createdBy: string; createdAt: string };
type Certification = { level: string; by: string; at: string };

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
};

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

function physicalFqn(domain: string, layer: Layer, name: string): string {
  return `iceberg.${domain}.${layer}_${slug(name)}`;
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
const VIS_WORD: Record<string, string> = { private: 'Private', domain: 'Domain', shared: 'Shared', public: 'Public' };

/**
 * Dataset detail panel — the "look at and document this dataset" surface.
 * Surfaces materialization status, tier/visibility, Cube readiness, and published
 * state as honest status chips; lets the owner edit description + column docs and
 * add data-quality check intentions; links through to the build flow.
 *
 * NO Cube registration state is read from the backend (no endpoint exists yet) —
 * "Cube model ready" is derived client-side from the governed-tier + gold-built
 * rule that `cubeDeliverable` enforces on the server, and labelled as such.
 */
export default function DatasetDetail({
  datasetId,
  onBack,
  onOpenStepper,
}: {
  datasetId: string;
  onBack: () => void;
  onOpenStepper: (id: string) => void;
}) {
  const { user } = useUser();
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [checks, setChecks] = useState<DataCheck[]>([]);
  const [loadErr, setLoadErr] = useState('');

  // ---- docs editing ----
  const [editingDocs, setEditingDocs] = useState(false);
  const [desc, setDesc] = useState('');
  const [cols, setCols] = useState<ColumnDoc[]>([]);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsErr, setDocsErr] = useState('');
  const [docsOk, setDocsOk] = useState('');

  // ---- checks ----
  const [newCheckName, setNewCheckName] = useState('');
  const [newCheckDesc, setNewCheckDesc] = useState('');
  const [checksBusy, setChecksBusy] = useState(false);
  const [checksErr, setChecksErr] = useState('');

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

  const addCheck = useCallback(async () => {
    if (!newCheckName.trim()) return;
    setChecksErr(''); setChecksBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/checks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newCheckName.trim(), description: newCheckDesc.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setChecksErr(data.error ?? 'Could not add check'); return; }
      setChecks((prev) => [...prev, data.check]);
      setNewCheckName(''); setNewCheckDesc('');
    } catch (e) {
      setChecksErr((e as Error).message);
    } finally {
      setChecksBusy(false);
    }
  }, [datasetId, newCheckName, newCheckDesc]);

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
  const fqn = layer ? physicalFqn(dataset.domain, layer, dataset.name) : null;
  const cubeReady = isCubeReady(dataset);
  const published = !!dataset.certification;
  const canEdit = !!user && (user.id === dataset.owner || (user.role === 'admin' && user.domains?.includes(dataset.domain)));

  return (
    <>
      {/* ── Nav ── */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn ghost" onClick={onBack}>← Datasets</button>
        <button className="btn ghost" onClick={() => onOpenStepper(dataset.id)}>
          Build / refine →
        </button>
      </div>

      {/* ── Header ── */}
      <div className="stepper-head">
        <h2 className="stepper-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
          {dataset.name}
        </h2>
        <span className={`badge ${TIER_BADGE[dataset.tier]}`}>{TIER_WORD[dataset.tier]}</span>
        <span className="muted" style={{ fontSize: 13 }}>{dataset.owner} · {dataset.domain}</span>
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
            title="No medallion layer built yet — open Build / refine to materialise it"
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

      {/* ── Documentation ── */}
      <div className="section-title" style={{ marginTop: 4 }}>
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

      {/* ── Data checks ── */}
      <div className="section-title" style={{ marginTop: 4 }}>
        Data checks
        <span className="count-pill">{checks.length}</span>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
        Check intentions recorded alongside this dataset — NOT auto-executed by the OS.
        Wire a data quality tool (dbt tests, Great Expectations, Soda, …) to run them.
      </p>

      {checks.length > 0 ? (
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Description</th>
                <th>Added by</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((chk) => (
                <tr key={chk.id}>
                  <td style={{ fontWeight: 600 }}>{chk.name}</td>
                  <td className="muted" style={{ whiteSpace: 'normal' }}>{chk.description || '—'}</td>
                  <td className="muted">{chk.createdBy}</td>
                  <td className="muted">{chk.createdAt ? formatDate(chk.createdAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>No checks defined yet.</p>
      )}

      {canEdit ? (
        <div className="guided-panel" style={{ padding: '12px 16px' }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Add a check</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input
              style={{ maxWidth: 220 }}
              placeholder="Check name (e.g. no null ids)"
              value={newCheckName}
              onChange={(e) => setNewCheckName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addCheck(); }}
            />
            <input
              style={{ flex: 1, minWidth: 160 }}
              placeholder="What it verifies"
              value={newCheckDesc}
              onChange={(e) => setNewCheckDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addCheck(); }}
            />
            <button
              className="btn"
              onClick={addCheck}
              disabled={checksBusy || !newCheckName.trim()}
            >
              {checksBusy ? <span className="spin" /> : 'Add'}
            </button>
          </div>
          {checksErr ? <div className="error" style={{ marginTop: 8 }}>{checksErr}</div> : null}
        </div>
      ) : null}

      {/* ── Sharing / promotion hint ── */}
      {dataset.tier === 'dataset' ? (
        <div className="gate-check" style={{ marginTop: 20 }}>
          <span className="badge vis-personal">Personal</span>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            This dataset is in your personal lane (DuckDB sandbox).
            Use <strong>Build / refine →</strong> to build a Silver or Gold version
            and request promotion to share it with your domain.
          </span>
        </div>
      ) : dataset.tier === 'asset' ? (
        <div className="gate-check gate-ok" style={{ marginTop: 20 }}>
          <span className="badge vis-shared">Shared</span>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            Promoted data asset in <strong>Trino/Iceberg</strong> ({dataset.domain} domain).
            An Admin can certify it as a data product to list it in the marketplace.
          </span>
        </div>
      ) : dataset.tier === 'product' ? (
        <div className="gate-check gate-ok" style={{ marginTop: 20 }}>
          <span className="badge vis-certified">Certified</span>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            Certified data product — discoverable across the marketplace.
          </span>
        </div>
      ) : null}
    </>
  );
}
