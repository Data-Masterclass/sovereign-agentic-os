/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { CAPABILITY_MODES, type CapabilityMode } from '@/lib/connection-model';

/**
 * Governed Connections surface (Connections golden path). A Builder/Admin creates
 * a Connection (API/MCP/Database/SaaS) → endpoint + credential (to Secrets
 * Manager, never the record) → tests it → tunes the per-tool capability profile
 * (Off/Read/Write-approval/Write-bounded/Blocked + limits) → promotes it up the
 * Personal→Shared→Marketplace ladder. Participants see a read-only consume view.
 */

type Tool = {
  name: string;
  description: string;
  write: boolean;
  mode: CapabilityMode;
  limits?: { dataScope?: string; rateLimitPerMin?: number; costCapUsd?: number; maxAmount?: number; argConstraints?: string };
};
type Grant = { agent: string; scope: string; tools: string[] };
type Conn = {
  id: string;
  name: string;
  type: string;
  template: string;
  endpoint: string;
  principal: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  mode: string;
  secretRef: { name: string; key: string };
  secretSet: boolean;
  secretFingerprint: string;
  egress: { external: boolean; host: string; allowed: boolean };
  tools: Tool[];
  grants: Grant[];
};
type Template = { key: string; label: string; type: string; endpointHint: string };
type Data = {
  user: { id: string; role: string };
  connections: Conn[];
  templates: Template[];
  canCreate: boolean;
};

function badge(v: string) {
  return `badge vis-${v.toLowerCase()}`;
}
function modeBadge(m: CapabilityMode) {
  if (m === 'Read') return 'badge ok';
  if (m === 'Write-bounded') return 'badge warn';
  if (m === 'Write-approval') return 'badge warn';
  if (m === 'Blocked') return 'badge err';
  return 'badge muted';
}

export default function GovernedConnections() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/connections', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load connections');
      else setData(body as Data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---- New connection form ----
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('notion-mcp');
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateMsg('');
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, template, endpoint, credential }),
      });
      const body = await res.json();
      if (!res.ok) setCreateMsg(`✗ ${body.error ?? 'Could not create connection'}`);
      else {
        setCreateMsg(`✓ Created "${body.connection.name}" — Personal. Credential stored as ref ${body.connection.secretRef.name}/${body.connection.secretRef.key} (never the value).`);
        setName('');
        setCredential('');
        load();
      }
    } catch (e) {
      setCreateMsg(`✗ ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  const canCreate = data?.canCreate ?? false;
  const tpl = data?.templates.find((t) => t.key === template);

  return (
    <>
      <div className="section-title">New connection</div>
      {canCreate ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
            Pick a type, give the endpoint + credential, and we wrap it as governed tools. The
            credential goes to <strong>Secrets Manager</strong> (the record keeps only a reference);
            external endpoints are checked against the <strong>egress allowlist</strong>. New
            connections are <strong>Personal</strong> with a safe preset profile (reads on, writes
            opt-in, deletes Blocked).
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Connection name (e.g. Notion workspace, Salesforce Sales org)" />
          <div className="row" style={{ marginTop: 10, gap: 10 }}>
            <select value={template} onChange={(e) => { setTemplate(e.target.value); setEndpoint(''); }} style={{ flex: 1 }}>
              {(data?.templates ?? []).map((t) => (
                <option key={t.key} value={t.key}>{t.label} · {t.type}</option>
              ))}
            </select>
          </div>
          <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={tpl ? `Endpoint (e.g. ${tpl.endpointHint})` : 'Endpoint'} style={{ marginTop: 10 }} />
          <input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Credential (API key / token / password) — goes to Secrets Manager" style={{ marginTop: 10 }} autoComplete="off" />
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={create} disabled={creating || !name.trim()}>
              {creating ? <span className="spin" /> : 'Create connection'}
            </button>
          </div>
          {createMsg ? <div className={createMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{createMsg}</div> : null}
        </>
      ) : (
        <div className="stub-page">
          Creating connections requires a <strong>Builder</strong> or <strong>Administrator</strong>.
          You consume connections that have been granted or shared to you.
        </div>
      )}

      <div className="section-title">Your governed connections</div>
      {error ? <div className="error">{error}</div> : null}
      {data && data.connections.length === 0 ? (
        <div className="stub-page">No governed connections yet{canCreate ? ' — create one above.' : '.'}</div>
      ) : null}
      {data?.connections.map((c) => (
        <ConnectionCard
          key={c.id}
          c={c}
          role={data.user.role}
          open={open === c.id}
          onToggle={() => setOpen(open === c.id ? '' : c.id)}
          onChange={load}
        />
      ))}
    </>
  );
}

function ConnectionCard({ c, role, open, onToggle, onChange }: { c: Conn; role: string; open: boolean; onToggle: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState<Tool[]>(c.tools);
  const canManage = role === 'builder' || role === 'admin';
  const exposed = c.tools.filter((t) => t.mode === 'Read' || t.mode === 'Write-approval' || t.mode === 'Write-bounded');

  async function post(path: string, body?: unknown, method = 'POST') {
    setBusy(path);
    setMsg('');
    try {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } finally {
      setBusy('');
    }
  }

  async function test() {
    const r = await post(`/api/connections/${c.id}/test`);
    setMsg(r.ok ? `✓ ${r.data.detail}` : `✗ ${r.data.error}`);
  }
  async function promote() {
    const r = await post(`/api/connections/${c.id}/promote`);
    setMsg(r.ok ? `✓ Promoted to ${r.data.connection.visibility}` : `✗ ${r.data.error}`);
    if (r.ok) onChange();
  }
  async function saveCaps() {
    const updates = draft.map((t) => ({ name: t.name, mode: t.mode, limits: t.limits }));
    const r = await post(`/api/connections/${c.id}/capabilities`, { updates });
    setMsg(r.ok ? '✓ Capability profile saved + recompiled into OPA policy' : `✗ ${r.data.error}`);
    if (r.ok) onChange();
  }
  async function tryTool(name: string) {
    const t = draft.find((x) => x.name === name);
    const args = t?.mode === 'Write-bounded' ? { id: 'OPP-1', amount: t.limits?.maxAmount ?? 1000 } : { id: 'ACME' };
    const r = await post(`/api/connections/${c.id}/tool`, { tool: name, args });
    const d = r.data;
    setMsg(`${d.decision === 'allow' ? '✓' : d.decision === 'requires_approval' ? '⏸' : '✗'} ${name}: ${d.decision} — ${d.reason ?? d.error}`);
    if (d.decision === 'requires_approval') onChange();
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>{c.name} <span className="badge muted" style={{ marginLeft: 6 }}>{c.type}</span></h3>
          <div className="muted mono" style={{ marginTop: 6, fontSize: 11.5 }}>
            {c.principal} · {c.owner}/{c.domain} · {c.endpoint}
          </div>
        </div>
        <span className={badge(c.visibility)}>{c.visibility}</span>
      </div>

      <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
        Secret: <span className="mono">{c.secretRef.name}/{c.secretRef.key}</span>{' '}
        {c.secretSet ? <span className="badge ok">stored</span> : <span className="badge muted">none</span>}{' '}
        {c.secretFingerprint ? <span className="mono" style={{ fontSize: 11 }}>{c.secretFingerprint}</span> : null}
        <span style={{ marginLeft: 10 }}>
          Egress:{' '}
          {c.egress.external ? (
            <span className={`badge ${c.egress.allowed ? 'ok' : 'err'}`}>{c.egress.host} {c.egress.allowed ? 'allowed' : 'blocked'}</span>
          ) : (
            <span className="badge muted">internal</span>
          )}
        </span>
      </div>

      <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
        Exposed tools: <span className="mono">{exposed.map((t) => t.name).join(', ') || '(none)'}</span>
        {c.grants.length ? <span style={{ marginLeft: 10 }}>Grants: {c.grants.map((g) => `${g.agent} (${g.scope})`).join(', ')}</span> : null}
      </div>

      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost" onClick={test} disabled={busy !== ''}>Test</button>
        <button className="btn ghost" onClick={onToggle}>{open ? 'Hide capabilities' : 'Capabilities'}</button>
        {canManage && c.visibility !== 'Certified' ? (
          <button className="btn ghost" onClick={promote} disabled={busy !== ''}>
            {c.visibility === 'Personal' ? 'Promote → Shared' : 'List → Marketplace'}
          </button>
        ) : null}
      </div>
      {msg ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 10 }}>{msg}</div> : null}

      {open ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr><th>Tool</th><th>Mode</th><th>Limits</th><th></th></tr>
            </thead>
            <tbody>
              {draft.map((t, i) => (
                <tr key={t.name}>
                  <td>
                    <div className="mono" style={{ fontWeight: 600 }}>{t.name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{t.description}</div>
                  </td>
                  <td>
                    {canManage ? (
                      <select
                        value={t.mode}
                        onChange={(e) => {
                          const next = [...draft];
                          next[i] = { ...t, mode: e.target.value as CapabilityMode };
                          setDraft(next);
                        }}
                      >
                        {CAPABILITY_MODES.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={modeBadge(t.mode)}>{t.mode}</span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 11.5 }}>
                    {t.limits?.maxAmount !== undefined ? `≤ ${t.limits.maxAmount}` : ''}
                    {t.limits?.dataScope ? ` · ${t.limits.dataScope}` : ''}
                    {t.limits?.rateLimitPerMin ? ` · ${t.limits.rateLimitPerMin}/min` : ''}
                  </td>
                  <td>
                    <button className="btn ghost" style={{ padding: '3px 9px' }} onClick={() => tryTool(t.name)} disabled={busy !== ''}>Try</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canManage ? (
            <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={saveCaps} disabled={busy !== ''}>Save capability profile</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
