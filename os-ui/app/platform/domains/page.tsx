/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Domain = {
  id: string;
  name: string;
  owner: string;
  archived: boolean;
  layers: { ml: boolean; spark: boolean };
  template: string;
  createdAt: string;
};
type Template = { id: string; name: string; description: string; layers: { ml: boolean; spark: boolean } };

export default function DomainsPage() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [template, setTemplate] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/domains', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setDomains(body.domains ?? []);
        setTemplates(body.templates ?? []);
        if (!template && body.templates?.length) setTemplate(body.templates[0].id);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [template]);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async () => {
    if (!name.trim() || !owner.trim()) return;
    setBusy('create');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/domains', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, owner, template }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Create failed');
      else { setName(''); setOwner(''); await load(); }
    } finally {
      setBusy('');
    }
  }, [name, owner, template, load]);

  const patch = useCallback(async (d: Domain, body: Record<string, unknown>) => {
    setBusy(d.id);
    setError('');
    try {
      const res = await fetch(`/api/platform-admin/domains/${d.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Update failed');
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  return (
    <>
      <PageHeader title="Domains" crumb="platform · structural map of the tenant" />
      <div className="content">
        <p className="lead">
          Domains are the tenant&apos;s <strong>structural map</strong> — each is a bounded space with an
          owner, optional compute layers, and its own people and artifacts. Create them here; everything
          downstream (access, governance, spend) hangs off this shape.
        </p>

        <div className="section-title">Create domain</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="domain name (e.g. Sales Analytics)" />
            <input style={{ flex: '1 1 140px' }} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner (login)" />
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="btn" onClick={create} disabled={busy === 'create' || !name.trim() || !owner.trim()}>
              {busy === 'create' ? <span className="spin" /> : 'Create domain'}
            </button>
          </div>
          {templates.length ? (
            <div className="hint" style={{ marginTop: 8 }}>
              {templates.find((t) => t.id === template)?.description ?? 'Templates preset which optional layers start enabled.'}
            </div>
          ) : null}
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Domains<span className="count-pill">{domains.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Domain</th><th>Owner</th><th>Template</th><th>ML layer</th><th>Spark layer</th><th></th></tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} className={d.archived ? 'muted' : undefined}>
                  <td><strong>{d.name}</strong><div className="mono muted" style={{ fontSize: 11 }}>{d.id}</div></td>
                  <td>{d.owner}</td>
                  <td><span className="pa-tag">{d.template}</span></td>
                  <td>
                    <button
                      className={'switch' + (d.layers.ml ? ' on' : '')}
                      disabled={busy === d.id || d.archived}
                      onClick={() => patch(d, { op: 'layer', layer: 'ml', enabled: !d.layers.ml })}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{d.layers.ml ? 'ON' : 'OFF'}</span>
                    </button>
                  </td>
                  <td>
                    <button
                      className={'switch' + (d.layers.spark ? ' on' : '')}
                      disabled={busy === d.id || d.archived}
                      onClick={() => patch(d, { op: 'layer', layer: 'spark', enabled: !d.layers.spark })}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{d.layers.spark ? 'ON' : 'OFF'}</span>
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === d.id}
                      onClick={() => patch(d, { op: 'archive', archived: !d.archived })}>
                      {busy === d.id ? <span className="spin" /> : d.archived ? 'Unarchive' : 'Archive'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
