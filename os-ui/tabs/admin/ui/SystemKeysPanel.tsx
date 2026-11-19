/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * SystemKeysPanel — the model key of each agent system, for platform admins.
 *
 * FEATURE:
 *   • One row per agent system: does it have a usable key of its own, when was the key
 *     issued or last replaced, and its budget and limits.
 *   • The legacy-key sweep: when it last ran, what it deleted, what it could not — and a
 *     button to run it again.
 *   • "Replace key" per system: a new random key, the old one stops working.
 *
 * USER STORY:
 *   • As a platform admin I see which systems still need a Build before they can run, so a
 *     failed scheduled run is never the first I hear of it.
 *   • As a platform admin I manage keys centrally and never hold one: nothing on this panel
 *     shows a key, and nothing here lets me copy one.
 *
 * ARCHITECTURE:
 *   A thin client component over `/api/platform-admin/gateway/system-keys`. Every rule — what
 *   counts as usable, what the sweep deletes, how a rotation is done — lives on the server
 *   (`core/infra/agent-system-keys.ts`, `agent-system-key-sweep.ts`,
 *   `tabs/agents/lib/build/system-key-admin.ts`). The two actions post an action NAME and a
 *   system id; the server decides everything else.
 */
'use client';

import { useState } from 'react';
import { useApi } from '@core/ui/useApi';

type KeyRow = {
  systemId: string;
  name: string;
  state: 'ready' | 'missing' | 'unreadable' | 'not-configured' | 'store-unavailable';
  message?: string;
  createdAt?: number;
  rotatedAt?: number | null;
  caps?: { models: string[]; maxBudget: number; budgetDuration: string; rpmLimit: number; tpmLimit: number; maxParallelRequests: number };
};
type Sweep = { at: number; ok: boolean; scanned: number; deleted: { alias: string; reason: string }[]; failed: { alias: string; error: string }[]; error?: string };
type Payload = { systems: KeyRow[]; sweep: Sweep | null };

const STATE_LABEL: Record<KeyRow['state'], string> = {
  ready: 'Has its own key',
  missing: 'No key — needs a Build',
  unreadable: 'Key unreadable — needs a Rebuild',
  'not-configured': 'Encryption secret missing',
  'store-unavailable': 'Key store unreachable',
};

const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : '—');

function sweepLine(sweep: Sweep | null): string {
  if (sweep === null) return 'has not run in this process yet (it runs at start-up, once the gateway is reachable).';
  if (sweep.error) return `${when(sweep.at)} — could not list the gateway's keys (${sweep.error}); nothing was deleted.`;
  const failed = sweep.failed.length ? `, ${sweep.failed.length} could NOT be deleted` : '';
  return `${when(sweep.at)} — ${sweep.scanned} key(s) checked, ${sweep.deleted.length} deleted${failed}.`;
}

function capsLine(caps: KeyRow['caps']): string {
  if (!caps) return '—';
  const budget = caps.budgetDuration ? `$${caps.maxBudget} per ${caps.budgetDuration}` : `$${caps.maxBudget} in total`;
  return `${budget} · ${caps.rpmLimit} requests/min · ${caps.tpmLimit} tokens/min · ${caps.maxParallelRequests} at once · ${caps.models.length} model(s)`;
}

export default function SystemKeysPanel() {
  const { data, loading, error, reload } = useApi<Payload>('/api/platform-admin/gateway/system-keys');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const act = async (action: 'sweep' | 'rotate', systemId?: string) => {
    setBusy(systemId ?? action);
    setNote('');
    try {
      const res = await fetch('/api/platform-admin/gateway/system-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, systemId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; row?: { appliedDetail?: string; error?: string } | null };
      const why = body.error ?? body.row?.error ?? `request failed (${res.status})`;
      if (action === 'rotate') setNote(res.ok ? `Key replaced for ${systemId}. ${body.row?.appliedDetail ?? ''}` : `Key NOT replaced for ${systemId}: ${why}`);
      else if (!res.ok) setNote(`Sweep failed: ${why}`);
      await reload();
    } catch (e) {
      setNote(`Request failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const sweep = data?.sweep ?? null;
  const needBuild = (data?.systems ?? []).filter((s) => s.state !== 'ready').length;

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-head)', fontSize: 16, margin: 0 }}>Agent system model keys</h2>
        <button className="btn" onClick={() => act('sweep')} disabled={busy !== ''}>
          {busy === 'sweep' ? <span className="spin" /> : 'Remove old guessable keys now'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
        Each agent system calls the models with its own key, so its budget and limits apply to it alone. Keys are random,
        stored encrypted, and never shown. A system without a usable key does not run until it is built.
      </p>

      {loading ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>Reading the key store…</p> : null}
      {error ? <p style={{ fontSize: 13, margin: 0 }}>Could not read the key status: {error}</p> : null}
      {note ? <p role="status" style={{ fontSize: 13, margin: '0 0 10px' }}>{note}</p> : null}

      {data ? (
        <>
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>Last sweep for old keys:</strong> {sweepLine(sweep)}
          </p>
          {sweep && sweep.deleted.length > 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
              Deleted: {sweep.deleted.map((d) => `${d.alias} (${d.reason === 'derivable' ? 'guessable from the system id' : 'no budget, from the old reconcile'})`).join(', ')}.
              A system whose key was deleted needs one Rebuild.
            </p>
          ) : null}
          {sweep && sweep.failed.length > 0 ? (
            <p style={{ fontSize: 12, margin: '0 0 10px' }}>Not deleted: {sweep.failed.map((f) => `${f.alias} (${f.error})`).join(', ')}.</p>
          ) : null}

          {data.systems.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>No agent systems yet.</p>
          ) : (
            <>
              {needBuild > 0 ? (
                <p style={{ fontSize: 13, margin: '0 0 8px' }}>{needBuild} system(s) cannot run until they are built: open each one and press Build (Rebuild).</p>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>System</th><th>Key</th><th>Issued</th><th>Replaced</th><th>Budget and limits</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.systems.map((s) => (
                      <tr key={s.systemId}>
                        <td>{s.name}<div className="muted" style={{ fontSize: 11 }}>{s.systemId}</div></td>
                        <td title={s.message ?? ''}>
                          <span className={`badge ${s.state === 'ready' ? 'ok' : 'err'}`} style={{ fontSize: 11 }}>{STATE_LABEL[s.state]}</span>
                        </td>
                        <td>{when(s.createdAt)}</td>
                        <td>{when(s.rotatedAt)}</td>
                        <td style={{ fontSize: 12 }}>{capsLine(s.caps)}</td>
                        <td>
                          <button className="btn" onClick={() => act('rotate', s.systemId)} disabled={busy !== ''} title="Issue a new random key and delete the old one at the gateway">
                            {busy === s.systemId ? <span className="spin" /> : s.state === 'ready' ? 'Replace key' : 'Issue key'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
