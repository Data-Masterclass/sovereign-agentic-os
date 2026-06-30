/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

// Local type — intentionally not imported from lib
type Trust = {
  certified: boolean;
  freshness: number; // 0..1
  quality: number;   // 0..1
  imports: number;
  rating: number;    // 0..5
  ratingCount: number;
};
export type Listing = {
  id: string;
  productId: string;
  type: string;
  name: string;
  description: string;
  owner: string;
  ownerDomain: string;
  tags: string[];
  status: 'listed' | 'deprecated';
  accessPolicy: 'open' | 'approval';
  defaultMode: string;
  modeOptions: string[];
  trust: Trust;
  updatedAt: string;
  registry: 'openmetadata' | 'os-registry';
};

const TYPE_LABELS: Record<string, string> = {
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

export default function ListingCard({
  listing: l,
  onOpen,
  ownDomain = false,
}: {
  listing: Listing;
  onOpen: () => void;
  ownDomain?: boolean;
}) {
  const { trust } = l;
  const qualPct = Math.round(trust.quality * 100);
  const freshPct = Math.round(trust.freshness * 100);
  const rated = trust.ratingCount > 0;

  return (
    <div className="card launch-card">
      {/* Name + status badges */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div
          style={{
            fontFamily: 'var(--font-head)',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '0.2px',
            color: 'var(--text)',
            flex: 1,
            lineHeight: 1.3,
          }}
        >
          {l.name}
        </div>
        <div style={{ display: 'flex', gap: 5, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {trust.certified && <span className="badge vis-certified">Certified</span>}
          {l.status === 'deprecated' && <span className="badge warn">Deprecated</span>}
          {ownDomain && <span className="badge muted">Your domain</span>}
        </div>
      </div>

      {/* Type · domain */}
      <div className="muted" style={{ marginTop: 5, fontSize: 11.5 }}>
        {TYPE_LABELS[l.type] ?? l.type} · from <strong>{l.ownerDomain}</strong>
      </div>

      {/* Description */}
      <div
        className="muted"
        style={{ marginTop: 8, flex: 1, fontSize: 13, whiteSpace: 'normal', lineHeight: 1.5 }}
      >
        {l.description}
      </div>

      {/* Trust strip */}
      <div className="mkt-trust">
        <span className="mkt-trust-item">
          <span className="mkt-trust-label">Qual</span>
          <span className="mkt-bar-wrap">
            <span className="mkt-bar-fill" style={{ width: `${qualPct}%` }} />
          </span>
          <span className="mkt-trust-val">{qualPct}%</span>
        </span>
        <span className="mkt-trust-sep" />
        <span className="mkt-trust-item">
          <span className="mkt-trust-label">Fresh</span>
          <span className="mkt-bar-wrap">
            <span className="mkt-bar-fill" style={{ width: `${freshPct}%` }} />
          </span>
          <span className="mkt-trust-val">{freshPct}%</span>
        </span>
        <span className="mkt-trust-sep" />
        <span className="mkt-trust-stat">↘ {trust.imports.toLocaleString()}</span>
        <span className="mkt-trust-sep" />
        <span className="mkt-trust-stat">
          {rated ? `★ ${trust.rating.toFixed(1)} (${trust.ratingCount})` : 'unrated'}
        </span>
      </div>

      {/* Tags (max 4 + overflow chip) */}
      {l.tags.length > 0 && (
        <div className="sources" style={{ marginTop: 10 }}>
          {l.tags.slice(0, 4).map((t) => (
            <span className="chip" key={t}>{t}</span>
          ))}
          {l.tags.length > 4 && (
            <span className="chip">+{l.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button className="btn" style={{ padding: '7px 15px', fontSize: 12 }} onClick={onOpen}>
          View & import →
        </button>
      </div>
    </div>
  );
}
