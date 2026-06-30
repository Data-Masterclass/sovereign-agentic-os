/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';

type Task = 'chat' | 'reasoning' | 'embedding';
type Model = { id: string; label: string; provider: string; task: Task; tier: 'sovereign' | 'premium'; route: string; enabled: boolean; capEUR: number | null };
type Key = { provider: string; fingerprint: string; addedBy: string; addedAt: string };

const TASKS: Task[] = ['chat', 'reasoning', 'embedding'];

export default function ModelsPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [defaults, setDefaults] = useState<Record<Task, string>>({ chat: '', reasoning: '', embedding: '' });
  const [keys, setKeys] = useState<Key[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [provider, setProvider] = useState('');
  const [value, setValue] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/models', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else { setModels(body.models ?? []); setDefaults(body.defaults ?? {}); setKeys(body.keys ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (id: string, payload: Record<string, unknown>) => {
    setBusy(id); setError('');
    try {
      const res = await fetch(`/api/platform-admin/models/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Update failed');
      else await load();
    } finally { setBusy(''); }
  }, [load]);

  const addKey = useCallback(async () => {
    if (!provider.trim() || !value.trim()) return;
    setBusy('key'); setError('');
    try {
      const res = await fetch('/api/platform-admin/models', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, value }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to store key');
      else { setToast(`Stored ${provider} key in the secrets manager — fingerprint ${body.key.fingerprint}. The raw value was never returned.`); setProvider(''); setValue(''); await load(); }
    } finally { setBusy(''); }
  }, [provider, value, load]);

  return (
    <>
      <PageHeader title="Models & Providers" crumb="platform · the LiteLLM catalog (sovereign + STACKIT)" />
      <div className="content">
        <p className="lead">
          Govern which models run. Self-hosted sovereign models (Magistral / Ministral / bge-m3) plus the
          STACKIT premium routes. Set the <strong>default per task</strong>, enable/disable, and cap
          per-model spend. Provider keys are added <strong>via the secrets manager</strong> — the OS stores
          a reference + fingerprint and <strong>never shows or logs the raw key</strong>.
        </p>

        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Default model per task</div>
        <div className="grid">
          {TASKS.map((t) => (
            <div className="card" key={t}>
              <h3>{t}</h3>
              <select
                value={defaults[t] ?? ''}
                disabled={busy !== ''}
                onChange={(e) => patch(e.target.value, { op: 'default', task: t })}
                style={{ width: '100%', marginTop: 6 }}
              >
                {models.filter((m) => m.task === t && m.enabled).map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>Catalog<span className="count-pill">{models.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Model</th><th>Route</th><th>Tier</th><th>Cap €/mo</th><th>Enabled</th></tr></thead>
            <tbody>
              {models.map((m) => {
                const isDefault = Object.values(defaults).includes(m.id);
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.label}</strong>{isDefault ? <span className="pa-tag" style={{ marginLeft: 8 }}>default</span> : null}
                      <div className="muted" style={{ fontSize: 11 }}>{m.id} · {m.task}</div>
                    </td>
                    <td>{m.route}</td>
                    <td><span className="pa-tag">{m.tier}</span></td>
                    <td>
                      <input
                        type="number" min={0} defaultValue={m.capEUR ?? ''} placeholder="none"
                        style={{ width: 90 }} disabled={busy === m.id}
                        onBlur={(e) => { const v = e.target.value.trim(); patch(m.id, { op: 'cap', capEUR: v === '' ? null : Number(v) }); }}
                      />
                    </td>
                    <td>
                      <button
                        className={`switch${m.enabled ? ' on' : ''}`} disabled={busy === m.id}
                        onClick={() => patch(m.id, { op: 'enable', enabled: !m.enabled })}
                        title={isDefault && m.enabled ? 'A default model cannot be disabled' : ''}
                      >
                        <span className="switch-track"><span className="switch-thumb" /></span>
                        <span className="switch-text">{m.enabled ? 'On' : 'Off'}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>Provider keys</div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 160px' }} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="provider (e.g. openai)" />
            <input style={{ flex: '1 1 220px' }} type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="API key value" autoComplete="off" />
            <button className="btn" onClick={addKey} disabled={busy === 'key' || !provider.trim() || !value.trim()}>
              {busy === 'key' ? <span className="spin" /> : 'Store via secrets manager'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            The value is written once to the secrets manager server-side. Only a <code>sha256</code> fingerprint
            is ever stored in the catalog or shown here.
          </div>
        </div>
        {keys.length === 0 ? <div className="hint">No provider keys stored.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Fingerprint</th><th>Added by</th><th>When</th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.provider}>
                    <td><strong>{k.provider}</strong></td>
                    <td className="mono" style={{ fontSize: 12 }}>{k.fingerprint}</td>
                    <td>{k.addedBy}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{new Date(k.addedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint" style={{ marginTop: 14 }}>
          Per-model caps tune the envelope set in <Link href="/platform/billing">Cost & Billing</Link>; live spend is in <Link href="/monitoring">Monitoring</Link>.
        </div>
      </div>
    </>
  );
}
