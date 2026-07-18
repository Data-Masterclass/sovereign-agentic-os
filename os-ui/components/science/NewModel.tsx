/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { postJson, TASK_TYPES, TASK_LABEL, type ModelSpec, type ModelSummary, type TaskType } from './shared';
import FolderTree, { type FolderTreeItem } from '@/components/core/FolderTree';
import { type FolderPathNode } from '@/lib/core/folders';
import { slug } from '@/lib/data/store-fqn';

/** Mirrors the shape returned by GET /api/data/datasets → .mine/.domain/.marketplace */
type DatasetTile = { id: string; name: string; domain: string; folder: string; tier: string };
type DatasetGroups = { mine: DatasetTile[]; domain: DatasetTile[]; marketplace: DatasetTile[] };

/** Build the FQN that the training job receives: `<domain>.<slug(name)>`. */
function datasetFqn(d: DatasetTile): string {
  return `${d.domain}.${slug(d.name)}`;
}

/**
 * DatasetExplorer — a FolderTree-backed dataset browser for single-select.
 * Uses `variant="nav"` with a `renderLeaf` that makes each dataset row clickable.
 * Fetches /api/data/datasets (DLS-scoped; same endpoint the Data tab uses) and
 * /api/folders?tab=data to get the governed folder structure.
 */
function DatasetExplorer({
  selected,
  onSelect,
}: {
  selected: string; // current FQN value
  onSelect: (fqn: string, name: string) => void;
}) {
  const [groups, setGroups] = useState<DatasetGroups | null>(null);
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [dsRes, pFolRes, dFolRes] = await Promise.all([
          fetch('/api/data/datasets', { cache: 'no-store' }),
          fetch('/api/folders?tab=data&scope=personal', { cache: 'no-store' }),
          fetch('/api/folders?tab=data&scope=domain', { cache: 'no-store' }),
        ]);
        if (!dsRes.ok) throw new Error('Failed to load datasets');
        const dsBody: DatasetGroups = await dsRes.json();
        if (!alive) return;
        setGroups(dsBody);

        const pBody = pFolRes.ok ? await pFolRes.json() : { folders: [] };
        const dBody = dFolRes.ok ? await dFolRes.json() : { folders: [] };
        if (!alive) return;

        // Synthesise folder nodes from the registry PLUS any implicit ancestor paths
        // carried on the items (mirrors the agent-builder AvailableFeed pattern).
        const allItems = [
          ...(dsBody.mine ?? []).map((d) => ({ id: d.id, folder: d.folder, scope: 'personal' as const })),
          ...(dsBody.domain ?? []).map((d) => ({ id: d.id, folder: d.folder, scope: 'domain' as const })),
          ...(dsBody.marketplace ?? []).map((d) => ({ id: d.id, folder: d.folder, scope: 'domain' as const })),
        ];
        const registryPersonal: FolderPathNode[] = (pBody.folders ?? []).map((f: { path: string }) => ({ path: f.path as string }));
        const registryDomain: FolderPathNode[] = (dBody.folders ?? []).map((f: { path: string }) => ({ path: f.path as string }));

        // Union registry rows + implicit ancestor nodes from each item's folder path.
        function addImplicit(nodes: FolderPathNode[], paths: string[]): FolderPathNode[] {
          const existing = new Set(nodes.map((n) => n.path));
          const extra: FolderPathNode[] = [];
          for (const p of paths) {
            if (p !== '/' && !existing.has(p)) { extra.push({ path: p }); existing.add(p); }
          }
          return [...nodes, ...extra];
        }
        setPersonalNodes(addImplicit(registryPersonal, allItems.filter((i) => i.scope === 'personal').map((i) => i.folder)));
        setDomainNodes(addImplicit(registryDomain, allItems.filter((i) => i.scope === 'domain').map((i) => i.folder)));
      } catch (e) {
        if (alive) setLoadErr((e as Error).message);
      }
    }
    void load();
    return () => { alive = false; };
  }, []);

  if (loadErr) return <div className="error" style={{ marginTop: 4 }}>{loadErr}</div>;
  if (!groups) return <p className="hint" style={{ marginTop: 4 }}>Loading datasets…</p>;

  // All datasets accessible to this user — flatten for the FolderTree items prop.
  // Each item carries its scope so FolderTree renders it under ONLY the correct root.
  const byId = new Map<string, DatasetTile>();
  for (const d of [...(groups.mine ?? []), ...(groups.domain ?? []), ...(groups.marketplace ?? [])]) byId.set(d.id, d);

  const treeItems: FolderTreeItem[] = [
    ...(groups.mine ?? []).map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: 'personal' as const })),
    ...(groups.domain ?? []).map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: 'domain' as const })),
    ...(groups.marketplace ?? []).map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: 'domain' as const })),
  ];

  const total = treeItems.length;
  if (total === 0) {
    return (
      <p className="hint" style={{ marginTop: 4 }}>
        No datasets found — create or share one in the Data tab first.
      </p>
    );
  }

  // Derive which roots to show: skip domain root if there are no domain/marketplace items.
  const hasDomain = (groups.domain ?? []).length + (groups.marketplace ?? []).length > 0;
  const roots: ('personal' | 'domain')[] = hasDomain ? ['personal', 'domain'] : ['personal'];

  return (
    <FolderTree
      variant="nav"
      personalNodes={personalNodes}
      domainNodes={domainNodes}
      roots={roots}
      items={treeItems}
      personalLabel="My datasets"
      domainLabel="Domain datasets"
      canCreateDomain={false}
      renderLeaf={(item) => {
        const tile = byId.get(item.id);
        const fqn = tile ? datasetFqn(tile) : item.id;
        const isSelected = selected === fqn;
        return (
          <button
            type="button"
            onClick={() => onSelect(fqn, item.name ?? item.id)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              textAlign: 'left',
              color: isSelected ? 'var(--gold-text)' : 'var(--text)',
              fontWeight: isSelected ? 600 : 400,
            }}
            title={fqn}
          >
            <span aria-hidden style={{ opacity: 0.7, fontSize: 12 }}>
              {tile?.tier === 'product' ? '🏅' : tile?.tier === 'asset' ? '📊' : '🗄'}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name ?? item.id}
            </span>
            {isSelected && (
              <span style={{ fontSize: 11, color: 'var(--gold-deep)', flexShrink: 0 }}>✓</span>
            )}
          </button>
        );
      }}
    />
  );
}

/**
 * ＋ New model — the DEFINE step of the model builder: capture what to learn from
 * what. It creates a `draft` model artifact (Personal tier, owned by you) via
 * `op:'create'`, then returns to its detail. The guided TRAIN / DEPLOY steps that
 * follow Define are Phase 2/3 — here we only register the spec, honestly.
 */
export default function NewModel({ onCreated }: { onCreated: (m: ModelSummary) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('binary_classification');
  const [sourceDataProductFqn, setSource] = useState('');
  const [selectedDatasetName, setSelectedDatasetName] = useState('');
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [targetColumn, setTarget] = useState('');
  const [algorithm, setAlgorithm] = useState('xgboost');
  const [features, setFeatures] = useState('');
  const [optimizeMetric, setMetric] = useState('auc');
  const [split, setSplit] = useState('0.8');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const unsupervised = taskType === 'clustering';

  async function create() {
    setErr('');
    if (!name.trim()) { setErr('Give the model a name.'); return; }
    if (!sourceDataProductFqn.trim()) { setErr('Point at a source data product.'); return; }
    const splitNum = Number(split);
    if (!(splitNum > 0 && splitNum < 1)) { setErr('Train/test split must be between 0 and 1.'); return; }
    const spec: ModelSpec = {
      sourceDataProductFqn: sourceDataProductFqn.trim(),
      targetColumn: unsupervised ? null : (targetColumn.trim() || null),
      taskType,
      algorithm: algorithm.trim() || 'auto',
      features: features.split(',').map((f) => f.trim()).filter(Boolean),
      trainTestSplit: splitNum,
      optimizeMetric: optimizeMetric.trim() || 'auc',
    };
    setBusy(true);
    try {
      const res = await postJson<{ model: ModelSummary; policy: ModelSummary['policy'] }>('/api/science/model', {
        op: 'create',
        name: name.trim(),
        description: description.trim() || undefined,
        spec,
      });
      onCreated({ ...res.model, policy: res.policy });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleDatasetSelect(fqn: string, dsName: string) {
    setSource(fqn);
    setSelectedDatasetName(dsName);
    setExplorerOpen(false);
  }

  const labelStyle = { display: 'block', marginBottom: 4 } as const;

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Define the model</div>
      <p className="muted" style={{ marginTop: -4 }}>
        Name it and describe what it should learn, from which governed data. This registers a{' '}
        <strong>draft</strong> — training and deploying it come next (Phase 2/3).
      </p>

      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="comp-label" style={labelStyle} htmlFor="nm-name">Name</label>
          <input id="nm-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead scoring" style={{ width: '100%' }} />
        </div>
        <div>
          <label className="comp-label" style={labelStyle} htmlFor="nm-desc">Description (optional)</label>
          <input id="nm-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it predicts and why" style={{ width: '100%' }} />
        </div>

        <div>
          <label className="comp-label" style={labelStyle}>Task type</label>
          <div className="rt-seg" role="group" aria-label="Task type" style={{ flexWrap: 'wrap' }}>
            {TASK_TYPES.map((t) => (
              <button key={t} type="button" className={`rt-seg-opt${taskType === t ? ' active' : ''}`} onClick={() => setTaskType(t)}>
                {TASK_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Source dataset — file-explorer picker using the shared FolderTree primitive. */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <label className="comp-label" style={{ margin: 0 }}>Source dataset</label>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setExplorerOpen((o) => !o)}
              aria-expanded={explorerOpen}
            >
              {explorerOpen ? 'Hide browser' : 'Browse datasets'}
            </button>
          </div>

          {/* Selected dataset badge — always visible once chosen. */}
          {selectedDatasetName ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 8,
                background: 'var(--gold-soft)',
                color: 'var(--gold-text)',
                marginBottom: explorerOpen ? 8 : 0,
                fontSize: 13,
              }}
            >
              <span style={{ opacity: 0.8 }}>📊</span>
              <span style={{ fontWeight: 600, flex: 1 }}>{selectedDatasetName}</span>
              <code style={{ fontSize: 11, opacity: 0.75 }}>{sourceDataProductFqn}</code>
              <button
                type="button"
                className="btn ghost sm"
                style={{ fontSize: 11, padding: '2px 6px' }}
                onClick={() => { setSource(''); setSelectedDatasetName(''); setExplorerOpen(true); }}
                title="Clear selection"
              >
                ×
              </button>
            </div>
          ) : null}

          {explorerOpen && (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '10px 12px',
                maxHeight: 280,
                overflowY: 'auto',
                background: 'var(--surface)',
              }}
            >
              <DatasetExplorer selected={sourceDataProductFqn} onSelect={handleDatasetSelect} />
            </div>
          )}

          {/* FQN override — editable after picking, or manually entered. */}
          <div style={{ marginTop: 6 }}>
            <label className="comp-label" style={{ ...labelStyle, color: 'var(--text-faint)', fontSize: 11 }} htmlFor="nm-src-fqn">
              FQN (auto-filled on pick; edit if needed)
            </label>
            <input
              id="nm-src-fqn"
              value={sourceDataProductFqn}
              onChange={(e) => { setSource(e.target.value); setSelectedDatasetName(''); }}
              placeholder="sales.customer_360"
              style={{ width: '100%', fontSize: 12 }}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <div>
            <label className="comp-label" style={labelStyle} htmlFor="nm-target">Target column{unsupervised ? ' (n/a)' : ''}</label>
            <input id="nm-target" value={targetColumn} onChange={(e) => setTarget(e.target.value)} disabled={unsupervised} placeholder={unsupervised ? '— unsupervised' : 'churned'} style={{ width: '100%' }} />
          </div>
          <div>
            <label className="comp-label" style={labelStyle} htmlFor="nm-algo">Algorithm</label>
            <input id="nm-algo" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)} placeholder="xgboost" style={{ width: '100%' }} />
          </div>
          <div>
            <label className="comp-label" style={labelStyle} htmlFor="nm-metric">Optimize metric</label>
            <input id="nm-metric" value={optimizeMetric} onChange={(e) => setMetric(e.target.value)} placeholder="auc" style={{ width: '100%' }} />
          </div>
        </div>

        <div>
          <label className="comp-label" style={labelStyle} htmlFor="nm-feats">Features (comma-separated)</label>
          <input id="nm-feats" value={features} onChange={(e) => setFeatures(e.target.value)} placeholder="recency_days, order_frequency, monetary_value" style={{ width: '100%' }} />
        </div>
        <div style={{ maxWidth: 200 }}>
          <label className="comp-label" style={labelStyle} htmlFor="nm-split">Train/test split (0–1)</label>
          <input id="nm-split" value={split} inputMode="decimal" onChange={(e) => setSplit(e.target.value.replace(/[^0-9.]/g, ''))} style={{ width: '100%' }} />
        </div>
      </div>

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      <div className="row" style={{ marginTop: 18, gap: 10 }}>
        <button className="btn" onClick={create} disabled={busy}>
          {busy ? <span className="spin" /> : 'Create draft model'}
        </button>
      </div>
    </div>
  );
}
