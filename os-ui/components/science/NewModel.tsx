/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { postJson, TASK_LABEL, TRAINABLE_TASKS, TASK_TYPES, isTrainableTask, type ModelSpec, type ModelSummary, type TaskType } from './shared';
import type { ModelDefinition } from './ScienceChat';
import FolderTree, { type FolderTreeItem } from '@/components/core/FolderTree';
import { type FolderPathNode } from '@/lib/core/folders';
import { slug } from '@/lib/data/store-fqn';

/** Mirrors the shape returned by GET /api/data/datasets → .mine/.domain/.marketplace */
type DatasetTile = { id: string; name: string; domain: string; folder: string; tier: string };
type DatasetGroups = { mine: DatasetTile[]; domain: DatasetTile[]; marketplace: DatasetTile[] };

/** The supported algorithms this CPU runtime can actually train (Developer picker, honest). */
const SUPPORTED_ALGORITHMS = ['auto', 'logistic', 'linear', 'random_forest'];
const SUPPORTED_METRICS = ['auto', 'auc', 'f1', 'rmse', 'mae'];

/** Build the FQN that the training job receives: `<domain>.<slug(name)>`. */
function datasetFqn(d: DatasetTile): string {
  return `${d.domain}.${slug(d.name)}`;
}

/**
 * DatasetExplorer — a FolderTree-backed dataset browser for single-select (unchanged).
 * Fetches /api/data/datasets (DLS-scoped) and /api/folders?tab=data for the governed tree.
 */
function DatasetExplorer({
  selected,
  onSelect,
}: {
  selected: string; // current FQN value
  onSelect: (fqn: string, name: string, id: string) => void;
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

        const allItems = [
          ...(dsBody.mine ?? []).map((d) => ({ id: d.id, folder: d.folder, scope: 'personal' as const })),
          ...(dsBody.domain ?? []).map((d) => ({ id: d.id, folder: d.folder, scope: 'domain' as const })),
          ...(dsBody.marketplace ?? []).map((d) => ({ id: d.id, folder: d.folder, scope: 'domain' as const })),
        ];
        const registryPersonal: FolderPathNode[] = (pBody.folders ?? []).map((f: { path: string }) => ({ path: f.path as string }));
        const registryDomain: FolderPathNode[] = (dBody.folders ?? []).map((f: { path: string }) => ({ path: f.path as string }));

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

  const byId = new Map<string, DatasetTile>();
  for (const d of [...(groups.mine ?? []), ...(groups.domain ?? []), ...(groups.marketplace ?? [])]) byId.set(d.id, d);

  const treeItems: FolderTreeItem[] = [
    ...(groups.mine ?? []).map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: 'personal' as const })),
    ...(groups.domain ?? []).map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: 'domain' as const })),
    ...(groups.marketplace ?? []).map((d) => ({ id: d.id, folder: d.folder, name: d.name, scope: 'domain' as const })),
  ];

  if (treeItems.length === 0) {
    return (
      <p className="hint" style={{ marginTop: 4 }}>
        No datasets found — create or share one in the Data tab first.
      </p>
    );
  }

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
            onClick={() => onSelect(fqn, item.name ?? item.id, item.id)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
              color: isSelected ? 'var(--gold-text)' : 'var(--text)', fontWeight: isSelected ? 600 : 400,
            }}
            title={fqn}
          >
            <span aria-hidden style={{ opacity: 0.7, fontSize: 12 }}>
              {tile?.tier === 'product' ? '🏅' : tile?.tier === 'asset' ? '📊' : '🗄'}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name ?? item.id}
            </span>
            {isSelected && <span style={{ fontSize: 11, color: 'var(--gold-deep)', flexShrink: 0 }}>✓</span>}
          </button>
        );
      }}
    />
  );
}

/**
 * Design a model — the DESIGN stage's manual path (progressive disclosure under the chat).
 * A business user picks a governed dataset, then chooses the target + feature COLUMNS from the
 * dataset's REAL profile (no free-text FQN / algorithm / metric / split to get wrong). The task
 * type is INFERRED from the target and shown as a plain sentence; forecast/clustering are gone
 * from Simple. Developer mode re-exposes the algorithm / optimize-metric / split as explicit
 * fields wired to ModelSpecInput, with the supported set shown honestly. Creating registers a
 * `draft` model artifact (Personal tier) via `op:'create'`.
 */
export default function NewModel({
  onCreated,
  prefill,
  developer = false,
  onColumns,
  onDataset,
}: {
  onCreated: (m: ModelSummary) => void;
  /** Chat suggestion to pre-fill the form (dataset/task/target/features). */
  prefill?: ModelDefinition | null;
  /** Developer mode re-exposes algorithm / metric / split. */
  developer?: boolean;
  /** Report the picked dataset's real column names up (feeds the chat grounding). */
  onColumns?: (cols: string[]) => void;
  /** Report the picked dataset {id, fqn} up (feeds the chat grounding). */
  onDataset?: (d: { id: string; fqn: string; name: string } | null) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('binary_classification');
  const [sourceDataProductFqn, setSource] = useState('');
  const [sourceDatasetId, setSourceId] = useState('');
  const [selectedDatasetName, setSelectedDatasetName] = useState('');
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [columns, setColumns] = useState<string[]>([]);
  const [profiling, setProfiling] = useState(false);
  const [targetColumn, setTarget] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  // Developer-only tuning knobs (blank ⇒ omitted ⇒ server task defaults via ModelSpecInput).
  const [algorithm, setAlgorithm] = useState('auto');
  const [optimizeMetric, setMetric] = useState('auto');
  const [split, setSplit] = useState('0.8');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const unsupervised = taskType === 'clustering';

  // Apply a chat suggestion when one arrives. Dataset selection is applied by the parent
  // (it fetches columns); here we honour task/target/features (validated against real columns).
  useEffect(() => {
    if (!prefill) return;
    if (prefill.taskType && isTrainableTask(prefill.taskType)) setTaskType(prefill.taskType);
    if (typeof prefill.targetColumn === 'string') setTarget(prefill.targetColumn);
    if (Array.isArray(prefill.features)) setFeatures(prefill.features);
  }, [prefill]);

  async function create() {
    setErr('');
    if (!name.trim()) { setErr('Give the model a name.'); return; }
    if (!sourceDataProductFqn.trim()) { setErr('Pick a source dataset.'); return; }
    if (!unsupervised && !targetColumn) { setErr('Pick the column to predict.'); return; }
    if (features.length === 0) { setErr('Pick at least one feature column to learn from.'); return; }
    // Simple omits the tuning knobs entirely (server fills task defaults). Developer sends them,
    // treating "auto" / blank as "let the server choose".
    const spec: ModelSpec & { algorithm?: string; optimizeMetric?: string; trainTestSplit?: number } = {
      sourceDataProductFqn: sourceDataProductFqn.trim(),
      sourceDatasetId: sourceDatasetId || undefined,
      targetColumn: unsupervised ? null : (targetColumn || null),
      taskType,
      features,
    } as ModelSpec;
    if (developer) {
      if (algorithm && algorithm !== 'auto') spec.algorithm = algorithm;
      if (optimizeMetric && optimizeMetric !== 'auto') spec.optimizeMetric = optimizeMetric;
      const splitNum = Number(split);
      if (split && splitNum > 0 && splitNum < 1) spec.trainTestSplit = splitNum;
    }
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

  function handleDatasetSelect(fqn: string, dsName: string, id: string) {
    setSource(fqn);
    setSourceId(id);
    setSelectedDatasetName(dsName);
    setExplorerOpen(false);
    setTarget('');
    setFeatures([]);
    setColumns([]);
    onDataset?.({ id, fqn, name: dsName });
    // Pull the dataset's REAL columns so target/features become pickers (not free text).
    setProfiling(true);
    fetch(`/api/data/datasets/${encodeURIComponent(id)}/profile`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        const cols = Array.isArray(p?.columns)
          ? p.columns.map((c: { name?: string }) => c?.name).filter((n: unknown): n is string => typeof n === 'string')
          : [];
        setColumns(cols);
        onColumns?.(cols);
      })
      .catch(() => { /* honest no-op — the picker just stays empty */ })
      .finally(() => setProfiling(false));
  }

  const labelStyle = { display: 'block', marginBottom: 4 } as const;
  // Feature choices exclude whatever is picked as the target.
  const featureChoices = columns.filter((c) => c !== targetColumn);

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Design the model by hand</div>
      <p className="muted" style={{ marginTop: -4 }}>
        Pick your data, choose the column to predict and the columns to learn from. We handle the
        rest and register a <strong>draft</strong> ready to launch.
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

        {/* Source dataset — file-explorer picker. */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <label className="comp-label" style={{ margin: 0 }}>Source dataset</label>
            <button type="button" className="btn ghost sm" onClick={() => setExplorerOpen((o) => !o)} aria-expanded={explorerOpen}>
              {explorerOpen ? 'Hide browser' : 'Browse datasets'}
            </button>
          </div>

          {selectedDatasetName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--gold-soft)', color: 'var(--gold-text)', marginBottom: explorerOpen ? 8 : 0, fontSize: 13 }}>
              <span style={{ opacity: 0.8 }}>📊</span>
              <span style={{ fontWeight: 600, flex: 1 }}>{selectedDatasetName}</span>
              <button
                type="button" className="btn ghost sm" style={{ fontSize: 11, padding: '2px 6px' }}
                onClick={() => { setSource(''); setSourceId(''); setSelectedDatasetName(''); setColumns([]); setTarget(''); setFeatures([]); setExplorerOpen(true); onDataset?.(null); }}
                title="Clear selection"
              >×</button>
            </div>
          ) : null}

          {explorerOpen && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', maxHeight: 280, overflowY: 'auto', background: 'var(--surface)' }}>
              <DatasetExplorer selected={sourceDataProductFqn} onSelect={handleDatasetSelect} />
            </div>
          )}
        </div>

        {/* Target + features become COLUMN PICKERS once a dataset is profiled. */}
        {sourceDataProductFqn ? (
          profiling ? (
            <p className="hint" style={{ marginTop: -4 }}><span className="spin" /> Reading the dataset’s columns…</p>
          ) : columns.length === 0 ? (
            <div className="hint">Couldn’t read this dataset’s columns automatically. Try another dataset, or ask the assistant above.</div>
          ) : (
            <>
              {!unsupervised ? (
                <div>
                  <label className="comp-label" style={labelStyle} htmlFor="nm-target">What should it predict?</label>
                  <select
                    id="nm-target"
                    value={targetColumn}
                    onChange={(e) => { setTarget(e.target.value); setFeatures((f) => f.filter((c) => c !== e.target.value)); }}
                    style={{ width: '100%' }}
                  >
                    <option value="">— pick a column —</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <div className="hint" style={{ marginTop: 4 }}>{taskSentence(taskType)}</div>
                </div>
              ) : null}

              <div>
                <label className="comp-label" style={labelStyle}>What should it learn from?</label>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {featureChoices.map((c) => {
                    const on = features.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        className={`rt-seg-opt${on ? ' active' : ''}`}
                        onClick={() => setFeatures((f) => (on ? f.filter((x) => x !== c) : [...f, c]))}
                      >
                        {on ? '✓ ' : ''}{c}
                      </button>
                    );
                  })}
                </div>
                <div className="hint" style={{ marginTop: 4 }}>
                  {features.length ? `${features.length} feature${features.length === 1 ? '' : 's'} selected` : 'Pick the columns the model should learn from.'}
                </div>
              </div>
            </>
          )
        ) : null}

        {/* Developer-only tuning: task type override + algorithm / metric / split, honest set. */}
        {developer ? (
          <div className="grant-block" style={{ marginTop: 2 }}>
            <div className="comp-label">Developer — training spec</div>
            <div style={{ marginTop: 8 }}>
              <label className="comp-label" style={labelStyle}>Task type</label>
              <div className="rt-seg" role="group" aria-label="Task type" style={{ flexWrap: 'wrap' }}>
                {TASK_TYPES.map((t) => {
                  const ok = isTrainableTask(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`rt-seg-opt${taskType === t ? ' active' : ''}`}
                      onClick={() => ok && setTaskType(t)}
                      disabled={!ok}
                      title={ok ? undefined : 'Not supported by this runtime'}
                      style={ok ? undefined : { opacity: 0.5 }}
                    >
                      {TASK_LABEL[t]}{ok ? '' : ' · not supported'}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 12 }}>
              <div>
                <label className="comp-label" style={labelStyle} htmlFor="nm-algo">Algorithm</label>
                <select id="nm-algo" value={algorithm} onChange={(e) => setAlgorithm(e.target.value)} style={{ width: '100%' }}>
                  {SUPPORTED_ALGORITHMS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className="comp-label" style={labelStyle} htmlFor="nm-metric">Optimize metric</label>
                <select id="nm-metric" value={optimizeMetric} onChange={(e) => setMetric(e.target.value)} style={{ width: '100%' }}>
                  {SUPPORTED_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="comp-label" style={labelStyle} htmlFor="nm-split">Train/test split (0–1)</label>
                <input id="nm-split" value={split} inputMode="decimal" onChange={(e) => setSplit(e.target.value.replace(/[^0-9.]/g, ''))} style={{ width: '100%' }} />
              </div>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Leave a knob on <code>auto</code> to let the runtime choose the honest default. Supported task
              types: {TRAINABLE_TASKS.map((t) => TASK_LABEL[t]).join(', ')}.
            </p>
          </div>
        ) : null}
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

/** The inferred task, phrased for a business user (Simple never asks them to pick it). */
function taskSentence(t: TaskType): string {
  switch (t) {
    case 'regression':
      return 'This looks like predicting a number (a value or amount).';
    case 'multiclass_classification':
      return 'This looks like sorting each record into one of several categories.';
    case 'binary_classification':
    default:
      return 'This looks like a yes/no prediction (will it happen or not).';
  }
}
