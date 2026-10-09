/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * Import dialog for a Marketplace listing. A centered modal over a backdrop that
 * lets the importer choose a mode (read-grant / fork / deploy-instance /
 * template) and target domain, then POSTs the import and shows the resulting
 * governed grant (201) or an approval hand-off to Governance (202).
 */

export type ListingLite = {
  id: string;
  productId: string;
  type: ProductType;
  name: string;
  description: string;
  owner: string;
  ownerDomain: string;
  tags: string[];
  status: 'listed' | 'deprecated';
  accessPolicy: 'open' | 'approval';
  defaultMode: ImportMode;
  modeOptions: ImportMode[];
  trust: { certified: boolean; freshness: number; quality: number; imports: number; rating: number; ratingCount: number };
  updatedAt: string;
  registry: string;
};

type ProductType =
  | 'dataset' | 'transformation' | 'metric' | 'dashboard' | 'agent'
  | 'knowledge' | 'connection' | 'file' | 'app';
type ImportMode = 'read-grant' | 'fork' | 'deploy-instance' | 'template';
type EnforcementTarget = 'opa-trino' | 'cube-rls' | 'opensearch-dls' | 'instance' | 'template' | 'copy';

type Grant = {
  id: string;
  listingId: string;
  type: ProductType;
  productName: string;
  mode: ImportMode;
  granteeDomain: string;
  ownerDomain: string;
  scope: { rows: string; columns?: string[] };
  enforcedBy: EnforcementTarget;
  status: 'active' | 'pending' | 'revoked';
  approvalId?: string;
  derivedId?: string;
};

const MODE_LABEL: Record<ImportMode, string> = {
  'read-grant': 'Read in place (governed grant)',
  fork: 'Fork to own (editable copy)',
  'deploy-instance': 'Deploy your own instance',
  template: 'Use as template (your own creds)',
};

const MODE_NOTE: Record<ImportMode, string> = {
  'read-grant': 'Query in place under your own identity; RLS scopes you to your rows. Owner stays source of truth.',
  fork: 'A governed editable copy in your domain (may drift).',
  'deploy-instance': 'Provisions your own instance.',
  template: 'Creates a connection from the template — bring your own credentials.',
};

const ENFORCEMENT_LABEL: Record<EnforcementTarget, string> = {
  'cube-rls': 'Cube row-level security',
  'opensearch-dls': 'OpenSearch Document-Level Security',
  'opa-trino': 'Trino + OPA row filter',
  copy: 'Forked copy',
  template: 'Connection template',
  instance: 'Own instance',
};

export default function ImportDialog({
  listing,
  viewerDomains,
  onDone,
  onClose,
}: {
  listing: ListingLite;
  viewerDomains: string[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ImportMode>(listing.defaultMode);
  const [as, setAs] = useState<string>(viewerDomains[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ grant: Grant; pending: boolean; note: string } | null>(null);

  async function doImport() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/marketplace/${listing.id}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, as: viewerDomains.length > 1 ? as : undefined }),
      });
      const body = await res.json();
      if (res.status !== 201 && res.status !== 202) {
        setError(body.error ?? `Import failed (${res.status})`);
      } else {
        setResult({ grant: body.grant as Grant, pending: Boolean(body.pending), note: body.note ?? '' });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.55)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 96vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--bg)',
          border: '1px solid var(--border-strong)',
          borderRadius: 14,
          boxShadow: '0 30px 80px -30px rgba(0,0,0,0.8)',
          padding: '22px 24px 24px',
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Import {listing.name}</h2>
          <button className="drawer-x" onClick={onClose} aria-label="Close" style={{ color: 'var(--text-muted)' }}>
            ×
          </button>
        </div>

        {result ? (
          <ResultPanel result={result} onDone={onDone} fallbackMode={mode} />
        ) : (
          <>
            <div className="section-title" style={{ marginTop: 16 }}>
              How do you want it
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {listing.modeOptions.map((m) => (
                <label
                  key={m}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '11px 13px',
                    border: `1px solid ${mode === m ? 'var(--gold-line)' : 'var(--border)'}`,
                    borderRadius: 9,
                    background: mode === m ? 'var(--gold-soft)' : 'var(--panel)',
                    cursor: 'pointer',
                    transition: 'border-color 0.14s, background 0.14s',
                  }}
                >
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    style={{ width: 'auto', margin: '2px 0 0' }}
                  />
                  <span>
                    <span style={{ fontWeight: 600, color: 'var(--text)' }}>{MODE_LABEL[m]}</span>
                    <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                      {MODE_NOTE[m]}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {viewerDomains.length > 1 ? (
              <div style={{ marginTop: 16 }}>
                <label className="comp-label">Import into</label>
                <select value={as} onChange={(e) => setAs(e.target.value)}>
                  {viewerDomains.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {listing.accessPolicy === 'approval' ? (
              <p className="hint" style={{ marginTop: 14 }}>
                This import needs the owner&apos;s approval — it will appear in Governance.
              </p>
            ) : null}

            {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}

            <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn" onClick={doImport} disabled={busy}>
                {busy ? <span className="spin" /> : 'Import'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ResultPanel({
  result: r,
  onDone: done,
  fallbackMode,
}: {
  result: { grant: Grant; pending: boolean; note: string };
  onDone: () => void;
  fallbackMode: ImportMode;
}) {
  const g = r.grant;
  const modeLabel = MODE_LABEL[g.mode] ?? MODE_LABEL[fallbackMode];
  return (
    <div style={{ marginTop: 18 }}>
      {r.pending ? (
        <div
          style={{
            border: '1px solid var(--gold-line)',
            borderLeft: '3px solid var(--gold)',
            borderRadius: 'var(--radius)',
            background: 'var(--gold-soft)',
            padding: 16,
          }}
        >
          <span className="badge warn">Sent to Governance for approval</span>
          <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: 13 }}>
            {r.note || `${modeLabel} is pending the owner's approval.`}
          </p>
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--teal)',
            borderRadius: 'var(--radius)',
            background: 'var(--panel)',
            padding: 16,
          }}
        >
          <span className="badge ok">{modeLabel} granted</span>
          <div className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>
            <div>Enforced by: <strong style={{ color: 'var(--text)' }}>{ENFORCEMENT_LABEL[g.enforcedBy]}</strong></div>
            {g.scope?.rows ? (
              <div>Your scope: <span className="mono" style={{ fontSize: 12 }}>{g.scope.rows}</span></div>
            ) : null}
            {g.derivedId ? (
              <div>Created: <span className="mono" style={{ fontSize: 12 }}>{g.derivedId}</span></div>
            ) : null}
          </div>
          {r.note ? <p className="hint" style={{ marginTop: 10 }}>{r.note}</p> : null}
        </div>
      )}
      <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={done}>Done</button>
      </div>
    </div>
  );
}
