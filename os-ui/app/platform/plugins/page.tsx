/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Plugin = {
  id: string;
  name: string;
  kind: 'mcp' | 'skill' | 'tool';
  publisher: string;
  signed: boolean;
  scanned: boolean;
  status: 'available' | 'installed' | 'approved';
  allowedDomains: string[];
  summary: string;
};
type Registration = {
  registered: boolean;
  listingName: string;
  partnerId: string;
  status: 'unregistered' | 'pending' | 'listed';
};

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // per-plugin approve picker
  const [approveText, setApproveText] = useState<Record<string, string>>({});
  // marketplace registration form
  const [partnerId, setPartnerId] = useState('');
  const [listingName, setListingName] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/plugins', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setPlugins(body.plugins ?? []);
        setRegistration(body.registration ?? null);
        setDomains(body.domains ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/platform-admin/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) setError(b.error ?? 'Action failed');
      else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  return (
    <>
      <PageHeader title="Plugins" crumb="platform · curate plugins & marketplace" />
      <div className="content">
        <p className="lead">
          Curate which plugins — MCP servers, skills, and tools — your domains may use. Install requires a
          plugin to be both <strong>signed</strong> and <strong>scanned</strong>. This is distinct from the
          internal product Marketplace tab; here you govern the supply chain.
        </p>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Plugins<span className="count-pill">{plugins.length}</span></div>
        <div className="grid">
          {plugins.map((p) => {
            const installable = p.signed && p.scanned && p.status === 'available';
            return (
              <div key={p.id} className="card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{p.name}</strong>
                  <span className="pa-tag">{p.kind}</span>
                </div>
                <div className="muted" style={{ fontSize: 11.5 }}>by {p.publisher}</div>
                <p className="muted" style={{ margin: '8px 0', fontSize: 12.5 }}>{p.summary}</p>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className={`badge ${p.signed ? 'ok' : 'err'}`}>{p.signed ? 'signed' : 'unsigned'}</span>
                  <span className={`badge ${p.scanned ? 'ok' : 'err'}`}>{p.scanned ? 'scanned' : 'unscanned'}</span>
                  <span className="badge muted">{p.status}</span>
                </div>
                {p.allowedDomains.length ? (
                  <div style={{ marginTop: 8 }}>{p.allowedDomains.map((d) => <span className="chip" key={d}>{d}</span>)}</div>
                ) : null}
                <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn" disabled={busy === p.id || !installable}
                    onClick={() => post(p.id, { op: 'install', id: p.id })}>
                    {busy === p.id ? <span className="spin" /> : 'Install'}
                  </button>
                  <input
                    style={{ flex: '1 1 140px' }}
                    value={approveText[p.id] ?? ''}
                    onChange={(e) => setApproveText((s) => ({ ...s, [p.id]: e.target.value }))}
                    placeholder={domains.length ? `domains (${domains.join(', ')})` : 'domains, comma-separated'}
                  />
                  <button className="btn ghost" disabled={busy === p.id}
                    onClick={() => post(p.id, {
                      op: 'approve',
                      id: p.id,
                      domains: (approveText[p.id] ?? '').split(',').map((d) => d.trim()).filter(Boolean),
                    })}>
                    Approve for domains
                  </button>
                </div>
                {!installable ? (
                  <div className="hint" style={{ marginTop: 6 }}>
                    {p.status !== 'available' ? `Already ${p.status}.` : 'Install needs both signed & scanned.'}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>External STACKIT marketplace</div>
        <div className="card">
          {registration ? (
            <>
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                Listing status:{' '}
                <span className={`badge ${registration.status === 'listed' ? 'ok' : registration.status === 'pending' ? 'muted' : 'err'}`}>
                  {registration.status}
                </span>
                {registration.registered ? <span className="muted" style={{ fontSize: 12 }}>{registration.listingName} · {registration.partnerId}</span> : null}
              </div>
              {!registration.registered ? (
                <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <input style={{ flex: '1 1 140px' }} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="partner ID" />
                  <input style={{ flex: '1 1 160px' }} value={listingName} onChange={(e) => setListingName(e.target.value)} placeholder="listing name (optional)" />
                  <button className="btn" disabled={busy === 'register' || !partnerId.trim()}
                    onClick={() => post('register', { op: 'register', partnerId, listingName: listingName || undefined })}>
                    {busy === 'register' ? <span className="spin" /> : 'Register'}
                  </button>
                </div>
              ) : (
                <div className="hint" style={{ marginTop: 8 }}>Registered with the external STACKIT marketplace.</div>
              )}
            </>
          ) : <div className="hint">Loading…</div>}
        </div>
      </div>
    </>
  );
}
