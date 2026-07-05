/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/session';

type Trust = 'bronze' | 'silver' | 'gold';
type Certification = { level: Trust; by: string; at: string };
type Approval = { id: string; status: 'pending' | 'approved' | 'rejected'; detail: string; decidedBy?: string };
type Status = { tier: 'dataset' | 'asset' | 'product'; certification: Certification | null; imports: string[]; request: Approval | null };

/**
 * Certify → Data Product + Marketplace (Admin). On an ASSET: a domain Admin certifies
 * directly (OM certification badge + dataProduct + listing + broadened visibility), or
 * a Builder/owner requests it for an Admin to approve in Governance. On a PRODUCT: shows
 * the trust badge + importers, and the Admin can decertify (lineage-aware: blocked while
 * domains import it). Unshare an asset is likewise blocked while named individuals hold grants.
 */
export default function CertifyPanel({
  datasetId,
  owner,
  domain,
  onChanged,
}: {
  datasetId: string;
  owner: string;
  domain: string;
  onChanged: () => void;
}) {
  const { user } = useUser();
  const [status, setStatus] = useState<Status | null>(null);
  const [level, setLevel] = useState<Trust>('gold');
  const [visibility, setVisibility] = useState<'shared' | 'public'>('shared');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/data/datasets/${datasetId}/certify`, { cache: 'no-store' });
    const data = await res.json();
    if (res.ok) setStatus(data);
  }, [datasetId]);
  useEffect(() => { load(); }, [load]);

  const call = useCallback(async (path: string, body: Record<string, unknown>, tag: string) => {
    setErr(''); setBusy(tag);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Action failed'); return; }
      await load(); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId, load, onChanged]);

  if (!status) return <div className="guided-panel"><span className="spin" /></div>;

  const isAdmin = !!user && user.role === 'admin' && user.domains.includes(domain);
  // Unshare needs canEdit (owner or admin-in-domain) AND a Builder+ role — match the
  // store's guard so we never show an action the server will 403 (no dead controls).
  const canUnshare = isAdmin || (!!user && user.id === owner && roleAtLeast(user.role, 'builder'));
  const pending = status.request?.status === 'pending';

  // -------------------------------------------------- product (already certified) --
  if (status.tier === 'product') {
    return (
      <div className="guided-panel">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className={`badge cert-${status.certification?.level ?? 'gold'}`}>
            ✦ {status.certification?.level ?? 'gold'} certified
          </span>
          <span className="muted">
            Listed in the marketplace · imported by {status.imports.length} domain{status.imports.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          A governed data product. Certified by {status.certification?.by}. Other domains discover and import it
          from the marketplace; reads stay row/column-scoped to each importer.
        </p>
        {err ? <div className="error">{err}</div> : null}
        {isAdmin ? (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={() => call('lifecycle', { action: 'decertify' }, 'decert')} disabled={busy !== ''}>
              {busy === 'decert' ? <span className="spin" /> : 'Decertify'}
            </button>
            {status.imports.length > 0 ? <span className="hint" style={{ margin: 0 }}>Blocked while domains import it (remove subscribers first).</span> : null}
          </div>
        ) : null}
      </div>
    );
  }

  // ----------------------------------------------------------------- asset (certify) --
  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        This is a governed <strong>data asset</strong> shared with your domain. Certifying it makes a
        <strong> data product</strong>: an Admin signs off the trust badge and lists it in the marketplace for other domains.
      </p>

      {err ? <div className="error">{err}</div> : null}

      {pending ? (
        <div className="gate-check">
          <span className="badge warn">certification requested</span> <span className="muted">{status.request?.detail}</span>
          <div className="hint" style={{ marginTop: 6 }}>A domain Admin approves this in the <strong>Governance</strong> tab.</div>
        </div>
      ) : isAdmin ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted" style={{ fontSize: 12.5 }}>Trust badge</label>
          <select value={level} onChange={(e) => setLevel(e.target.value as Trust)}>
            <option value="bronze">bronze</option>
            <option value="silver">silver</option>
            <option value="gold">gold</option>
          </select>
          <label className="muted" style={{ fontSize: 12.5 }}>Visibility</label>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'shared' | 'public')}>
            <option value="shared">shared</option>
            <option value="public">public</option>
          </select>
          <button className="btn" onClick={() => call('certify', { action: 'certify', level, visibility }, 'cert')} disabled={busy !== ''}>
            {busy === 'cert' ? <span className="spin" /> : 'Certify now →'}
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => call('certify', { action: 'request', level }, 'req')} disabled={busy !== ''}>
          {busy === 'req' ? <span className="spin" /> : 'Request certification'}
        </button>
      )}

      {canUnshare && !pending ? (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn ghost sm" onClick={() => call('lifecycle', { action: 'unshare' }, 'unshare')} disabled={busy !== ''}>
            {busy === 'unshare' ? <span className="spin" /> : 'Unshare (back to a private dataset)'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
