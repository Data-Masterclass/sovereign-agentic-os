/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { postJson, TASK_TYPES, TASK_LABEL, type ModelSpec, type ModelSummary, type TaskType } from './shared';

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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          <div>
            <label className="comp-label" style={labelStyle} htmlFor="nm-src">Source data product (FQN)</label>
            <input id="nm-src" value={sourceDataProductFqn} onChange={(e) => setSource(e.target.value)} placeholder="sales.customer_360" style={{ width: '100%' }} />
          </div>
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
