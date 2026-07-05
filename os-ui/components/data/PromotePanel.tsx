/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';

type ColumnDoc = { name: string; description: string };
type Gate = { ok: boolean; missing: string[] };
type Approval = {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  detail: string;
  decidedBy?: string;
  /** The executed effect (T8): the PHYSICAL publish outcome behind the approval. */
  effect?: {
    applied: string;
    live: boolean;
    publish?: { ok: boolean; fqn: string; error?: string; mode?: string; cubeView?: string | null };
  };
};

/**
 * Promote → Data Asset (data-architecture-model.md). The documentation form (OM
 * required fields) + the live transparency-gate checklist, then the separation-of-
 * duties handoff: a Creator REQUESTS promotion (gated green); a domain Builder
 * APPROVES it from here or in Governance, which moves the dataset into Trino.
 */
export default function PromotePanel({
  datasetId,
  owner,
  domain,
  tier,
  initialDescription,
  initialColumns,
  onChanged,
}: {
  datasetId: string;
  owner: string;
  domain: string;
  tier: 'dataset' | 'asset' | 'product';
  initialDescription: string;
  initialColumns: ColumnDoc[];
  onChanged: () => void;
}) {
  const { user } = useUser();
  const [description, setDescription] = useState(initialDescription);
  const [columns, setColumns] = useState<ColumnDoc[]>(initialColumns.length ? initialColumns : [{ name: '', description: '' }]);
  const [gate, setGate] = useState<Gate | null>(null);
  const [request, setRequest] = useState<Approval | null>(null);
  const [visibility, setVisibility] = useState<'domain' | 'shared'>('domain');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const loadStatus = useCallback(async () => {
    const res = await fetch(`/api/data/datasets/${datasetId}/promote`, { cache: 'no-store' });
    const data = await res.json();
    if (res.ok) { setGate(data.gate); setRequest(data.request ?? null); }
  }, [datasetId]);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const saveDocs = useCallback(async () => {
    setErr(''); setBusy('docs');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/docs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description, columns: columns.filter((c) => c.name.trim()) }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not save docs'); return; }
      setGate(data.gate); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId, description, columns, onChanged]);

  const requestPromotion = useCallback(async () => {
    setErr(''); setBusy('request');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/promote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not request'); return; }
      setRequest(data.approval); loadStatus();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId, visibility, loadStatus]);

  if (tier !== 'dataset') {
    return (
      <div className="guided-panel">
        <span className="badge vis-shared">Promoted</span> This is a governed{' '}
        <strong>{tier === 'product' ? 'data product' : 'data asset'}</strong> in Trino/Iceberg — shared with your domain.
      </div>
    );
  }

  const isOwner = user?.id === owner;
  const pending = request?.status === 'pending';

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Sharing this dataset with your domain promotes it into governed Trino storage. It needs
        documentation first — then a <strong>Builder approves</strong> the promotion (you can’t promote your own).
      </p>

      {isOwner ? (
        <>
          <div className="section-title" style={{ marginTop: 4 }}>Documentation</div>
          <label className="muted" style={{ fontSize: 12.5 }}>What is this dataset?</label>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="One line a teammate in another domain would understand." />
          <div className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>Column meanings (at least one)</div>
          {columns.map((c, i) => (
            <div className="row" key={i} style={{ gap: 8, marginBottom: 6 }}>
              <input style={{ maxWidth: 180 }} placeholder="column" value={c.name}
                onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <input style={{ flex: 1 }} placeholder="what it means" value={c.description}
                onChange={(e) => setColumns((cs) => cs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => setColumns((cs) => [...cs, { name: '', description: '' }])}>+ Column</button>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={saveDocs} disabled={busy === 'docs'}>{busy === 'docs' ? <span className="spin" /> : 'Save documentation'}</button>
          </div>
        </>
      ) : null}

      {gate ? (
        <div className="gate-check" style={{ marginTop: 14 }}>
          <strong>{gate.ok ? '✓ Transparency gate green' : 'Transparency gate — still missing:'}</strong>
          {gate.ok ? null : (
            <ul className="gate-missing">{gate.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          )}
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}

      {/* Owner: request promotion */}
      {isOwner && !pending ? (
        <div className="row" style={{ marginTop: 14, gap: 8, alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: 12.5 }}>Share with</label>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'domain' | 'shared')}>
            <option value="domain">{domain} domain</option>
            <option value="shared">named people too</option>
          </select>
          <button className="btn" onClick={requestPromotion} disabled={!gate?.ok || busy === 'request'} title={gate?.ok ? '' : 'Complete the documentation first'}>
            {busy === 'request' ? <span className="spin" /> : 'Request promotion →'}
          </button>
        </div>
      ) : null}

      {/* Pending request status — a domain Builder approves it in the Governance tab. */}
      {pending ? (
        <div className="gate-check" style={{ marginTop: 14 }}>
          <span className="badge warn">promotion requested</span>{' '}
          <span className="muted">{request?.detail}</span>
          <div className="hint" style={{ marginTop: 6 }}>A domain Builder approves this in the <strong>Governance</strong> tab, which moves it into Trino.</div>
        </div>
      ) : null}

      {/* Physical-publish status, honestly: approved+no effect = materializing;
          effect.publish.ok = live table; effect w/o ok = the real failure. */}
      {request?.status === 'approved' && !request.effect ? (
        <div className="gate-check" style={{ marginTop: 14 }}>
          <span className="badge warn">materializing</span>{' '}
          <span className="muted">Approved by {request.decidedBy} — publishing the table into Trino…</span>
        </div>
      ) : null}
      {request?.status === 'approved' && request.effect?.publish?.ok ? (
        <div className="gate-check" style={{ marginTop: 14 }}>
          <span className="badge ok">live</span> Published by {request.decidedBy} →{' '}
          <code>{request.effect.publish.fqn}</code>
          {request.effect.publish.mode === 'live' ? '' : ' (offline-mock)'}
        </div>
      ) : null}
      {request?.status === 'approved' && request.effect && !request.effect.publish?.ok ? (
        <div className="gate-check" style={{ marginTop: 14 }}>
          <span className="badge err">publish failed</span>{' '}
          <span className="muted">
            {request.effect.publish?.error ?? request.effect.applied} — the dataset stays private (tier unchanged).
            Fix the issue and request promotion again.
          </span>
        </div>
      ) : null}
      {request?.status === 'rejected' ? (
        <div className="gate-check" style={{ marginTop: 14 }}><span className="badge err">rejected</span> by {request.decidedBy}.</div>
      ) : null}
    </div>
  );
}
