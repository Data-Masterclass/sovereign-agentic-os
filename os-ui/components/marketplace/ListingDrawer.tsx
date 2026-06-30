/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import ImportDialog, { type ListingLite } from './ImportDialog';

/**
 * Listing detail — a right-side slide-over panel. Fetches the full listing
 * detail (preview rows under the viewer's RLS, trust, lineage, importer usage)
 * and is the launch point for the import flow. Re-fetches when the "Preview as"
 * domain changes so the user sees how row-level security yields different rows
 * per domain.
 */

type ProductType =
  | 'dataset' | 'transformation' | 'metric' | 'dashboard' | 'agent'
  | 'knowledge' | 'connection' | 'file' | 'app';
type ImportMode = 'read-grant' | 'fork' | 'deploy-instance' | 'template';

type Preview =
  | { kind: 'rows'; columns?: string[]; rows?: string[][]; rlsApplied?: string }
  | { kind: 'text'; text?: string; rlsApplied?: string }
  | { kind: 'spec'; text?: string; rlsApplied?: string };

type LineageNode = { id: string; name: string; type: ProductType; relation: 'upstream' | 'importer'; domain: string };
type Importer = { domain: string; user: string; mode: ImportMode; status: string; at: string };

type Detail = ListingLite & {
  preview: Preview;
  lineage: LineageNode[];
  importers: Importer[];
};

type DetailResponse = { detail: Detail; source: string };

const TYPE_LABEL: Record<ProductType, string> = {
  dataset: 'Data product',
  transformation: 'Transformation',
  metric: 'Metric',
  dashboard: 'Dashboard',
  agent: 'Agent',
  knowledge: 'Knowledge',
  connection: 'Connection',
  file: 'Files',
  app: 'App',
};

const MODE_LABEL: Record<ImportMode, string> = {
  'read-grant': 'Read in place (governed grant)',
  fork: 'Fork to own (editable copy)',
  'deploy-instance': 'Deploy your own instance',
  template: 'Use as template (your own creds)',
};

const pct = (n: number) => `${Math.round((n <= 1 ? n * 100 : n))}%`;

export default function ListingDrawer({
  listingId,
  viewerDomains,
  isAdmin,
  onClose,
  onChanged,
}: {
  listingId: string;
  viewerDomains: string[];
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [as, setAs] = useState<string>(viewerDomains[0] ?? '');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [rating, setRating] = useState(false);
  const [hoverStar, setHoverStar] = useState(0);
  const [deprecateMsg, setDeprecateMsg] = useState('');
  const [warned, setWarned] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = as ? `?as=${encodeURIComponent(as)}` : '';
      const res = await fetch(`/api/marketplace/${listingId}${q}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      else setDetail((body as DetailResponse).detail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [listingId, as]);

  useEffect(() => {
    load();
  }, [load]);

  async function rate(stars: number) {
    if (rating) return;
    setRating(true);
    try {
      await fetch(`/api/marketplace/${listingId}/rate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stars }),
      });
      onChanged();
      await load();
    } finally {
      setRating(false);
    }
  }

  async function deprecate() {
    setDeprecateMsg('');
    try {
      const res = await fetch(`/api/marketplace/${listingId}/deprecate`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setDeprecateMsg(body.error ?? 'Could not deprecate');
      else {
        setWarned((body.warned ?? []) as string[]);
        onChanged();
        await load();
      }
    } catch (e) {
      setDeprecateMsg((e as Error).message);
    }
  }

  const ownerOwnedByViewer = detail ? viewerDomains.includes(detail.ownerDomain) : false;
  const canDeprecate = isAdmin && ownerOwnedByViewer && detail?.status !== 'deprecated';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end' }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 96vw)',
          height: '100%',
          background: 'var(--bg)',
          borderLeft: '1px solid var(--border-strong)',
          boxShadow: '-20px 0 60px -30px rgba(0,0,0,0.8)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'drawer-in 0.18s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: '18px 22px',
            borderBottom: '1px solid var(--border)',
            background: '#0c0b0d',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 17, color: '#f4f0e7' }}>{detail?.name ?? 'Listing'}</h2>
              {detail?.trust.certified ? <span className="badge vis-certified">Certified</span> : null}
              {detail?.status === 'deprecated' ? <span className="badge warn">Deprecated</span> : null}
            </div>
            {detail ? (
              <div style={{ color: '#b0a99c', fontSize: 12, marginTop: 4 }}>
                {TYPE_LABEL[detail.type]} · owned by {detail.ownerDomain} · {detail.registry}
              </div>
            ) : null}
          </div>
          <button className="drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 22px 28px', overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div className="hint"><span className="spin" /> Loading listing…</div>
          ) : error ? (
            <span className="badge err">{error}</span>
          ) : detail ? (
            <>
              {/* Description */}
              <p className="lead" style={{ fontSize: 14 }}>{detail.description}</p>

              {/* Trust */}
              <div className="section-title">Trust</div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <Stat label="Quality" value={pct(detail.trust.quality)} />
                <Stat label="Freshness" value={pct(detail.trust.freshness)} />
                <Stat label="Imports" value={String(detail.trust.imports)} />
              </div>
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div role="radiogroup" aria-label="Rate this listing" style={{ display: 'inline-flex', gap: 2 }} onMouseLeave={() => setHoverStar(0)}>
                  {[1, 2, 3, 4, 5].map((s) => {
                    const filled = (hoverStar || Math.round(detail.trust.rating)) >= s;
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-label={`${s} star${s > 1 ? 's' : ''}`}
                        disabled={rating}
                        onMouseEnter={() => setHoverStar(s)}
                        onClick={() => rate(s)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: rating ? 'default' : 'pointer',
                          padding: 0,
                          fontSize: 20,
                          lineHeight: 1,
                          color: filled ? 'var(--gold)' : 'var(--text-faint)',
                          transition: 'color 0.12s',
                        }}
                      >
                        {filled ? '★' : '☆'}
                      </button>
                    );
                  })}
                </div>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {detail.trust.rating.toFixed(1)} · {detail.trust.ratingCount} rating{detail.trust.ratingCount === 1 ? '' : 's'}
                  {rating ? <span className="spin" style={{ marginLeft: 8 }} /> : null}
                </span>
              </div>

              {/* Preview */}
              <div className="section-title">Preview</div>
              {viewerDomains.length > 1 ? (
                <div style={{ marginBottom: 12 }}>
                  <label className="comp-label">See your entitled rows</label>
                  <select aria-label="Preview as" value={as} onChange={(e) => setAs(e.target.value)}>
                    {viewerDomains.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
              ) : null}
              <PreviewBlock preview={detail.preview} />

              {/* Lineage */}
              <div className="section-title">Lineage</div>
              <LineageList nodes={detail.lineage} />

              {/* Usage (owner-visible) */}
              {detail.importers.length > 0 ? (
                <>
                  <div className="section-title">Usage</div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {detail.importers.map((im, i) => (
                      <div key={`${im.domain}-${i}`} className="muted" style={{ fontSize: 12.5 }}>
                        <strong style={{ color: 'var(--text)' }}>{im.domain}</strong> · {MODE_LABEL[im.mode] ?? im.mode} ·{' '}
                        <span className={im.status === 'active' ? 'badge ok' : im.status === 'pending' ? 'badge warn' : 'badge muted'}>{im.status}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              {warned ? (
                <p className="badge warn" style={{ marginTop: 16, display: 'inline-block' }}>
                  Importers warned: {warned.length ? warned.join(', ') : 'none'}
                </p>
              ) : null}
              {deprecateMsg ? <div className="error" style={{ marginTop: 12 }}>{deprecateMsg}</div> : null}
            </>
          ) : null}
        </div>

        {/* Footer actions */}
        {detail && !loading && !error ? (
          <div
            style={{
              display: 'flex',
              gap: 10,
              padding: '14px 22px',
              borderTop: '1px solid var(--border)',
              background: 'var(--panel)',
              flexWrap: 'wrap',
            }}
          >
            <button className="btn" onClick={() => setImporting(true)} disabled={detail.status === 'deprecated'}>Import</button>
            {canDeprecate ? (
              <button className="btn ghost" onClick={deprecate}>Deprecate</button>
            ) : null}
            <button className="btn ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Close</button>
          </div>
        ) : null}
      </aside>

      {importing && detail ? (
        <ImportDialog
          listing={detail}
          viewerDomains={viewerDomains}
          onDone={() => {
            setImporting(false);
            onChanged();
            load();
          }}
          onClose={() => setImporting(false)}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="comp-label" style={{ marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-head)', fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

function PreviewBlock({ preview }: { preview: Preview }) {
  if (preview.kind === 'rows') {
    const cols = preview.columns ?? [];
    const rows = preview.rows ?? [];
    return (
      <>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview.rlsApplied ? (
          <div className="hint" style={{ marginTop: 8 }}>Row-level security applied · {preview.rlsApplied}</div>
        ) : null}
      </>
    );
  }
  if (preview.kind === 'text') {
    return (
      <div className="muted" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
        {preview.text ?? '(no preview)'}
      </div>
    );
  }
  // spec
  return (
    <pre
      style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '12px 14px',
        overflowX: 'auto',
        fontSize: 12,
        margin: 0,
        whiteSpace: 'pre-wrap',
      }}
    >
      {preview.text ?? '(no spec)'}
    </pre>
  );
}

function LineageList({ nodes }: { nodes: LineageNode[] }) {
  const upstream = nodes.filter((n) => n.relation === 'upstream');
  const importers = nodes.filter((n) => n.relation === 'importer');
  if (nodes.length === 0) return <div className="muted" style={{ fontSize: 12.5 }}>No lineage recorded.</div>;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {upstream.map((n) => (
        <div key={n.id} className="muted" style={{ fontSize: 12.5 }}>
          ← {n.name} <span className="badge muted">{n.type}</span>
        </div>
      ))}
      {importers.map((n) => (
        <div key={n.id} className="muted" style={{ fontSize: 12.5 }}>
          → {n.name} <span className="badge muted">{n.type}</span>
        </div>
      ))}
    </div>
  );
}
