/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Tool consoles — one row per tool console, with its switch, status,
 *             address and a warning about what it shows
 * USER STORY: As a platform admin I switch the LiteLLM or Dagster console on before a demo and off
 *             afterwards, and I see at a glance which consoles this install can serve at all.
 * ARCHITECTURE:
 *   - A SHELL over `/api/platform-admin/tool-consoles` (GET list, PATCH {key, exposed}); every
 *     decision and the audit row are in tabs/admin/lib/tool-consoles.ts, the gate in the kernel.
 *   - FAIL CLOSED like the other admin sections: the inner component holds every hook and fetch
 *     and is not mounted until `useUser()` resolves a role that clears `sectionMinRole('tools')`.
 *   - The switch is disabled unless the console is "available" (or is on and may be turned off).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';

type Row = {
  key: string;
  title: string;
  exposed: boolean;
  status: 'available' | 'not-set-up' | 'pending';
  statusReason?: string;
  address: string;
  shortAddress: string | null;
  warning: string;
};

const STATUS_LABEL: Record<Row['status'], { text: string; cls: string }> = {
  available: { text: 'available', cls: 'ok' },
  'not-set-up': { text: 'not set up on this install', cls: 'muted' },
  pending: { text: 'not available yet', cls: 'warn' },
};

export default function ToolConsoles() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('tools'))) return null;
  return <ToolConsolesInner />;
}

function ToolConsolesInner() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform-admin/tool-consoles', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { consoles?: Row[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setRows(body.consoles ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(row: Row) {
    const next = !row.exposed;
    if (next && !window.confirm(`Switch the ${row.title} console on?\n\n${row.warning}\n\nOnly admins can open it, at ${row.address}.`)) return;
    setBusy(row.key);
    setError('');
    try {
      const res = await fetch('/api/platform-admin/tool-consoles', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: row.key, exposed: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div>
      <div className="section-title">Tool consoles</div>
      <div className="hint" style={{ marginBottom: 12 }}>
        The admin consoles of the tools inside the OS, served on this address behind the OS
        sign-in. Each one is off until you switch it on, and only admins can open it. Every change
        is recorded in the audit trail. Use the dev environment (synthetic data) for demos.
      </div>
      {error && <div className="badge err" style={{ marginBottom: 12 }}>{error}</div>}
      {rows === null ? (
        <div className="hint">Loading…</div>
      ) : (
        // The switch sits right after the tool name and the warning wraps under it, so the switch
        // is visible at any width; a table wider than the card scrolls inside it, never off-screen.
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Tool</th>
              <th>On</th>
              <th>Status</th>
              <th>Address</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = STATUS_LABEL[r.status];
              const canSwitch = r.exposed || r.status === 'available';
              return (
                <tr key={r.key}>
                  <td style={{ minWidth: 200, maxWidth: 420, whiteSpace: 'normal' }}>
                    <strong>{r.title}</strong>
                    {r.warning && <div className="hint" style={{ fontSize: 12, marginTop: 4 }}>{r.warning}</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className={'switch' + (r.exposed ? ' on' : '')}
                      onClick={() => void toggle(r)}
                      disabled={!canSwitch || busy === r.key}
                      aria-label={`${r.title} console ${r.exposed ? 'on' : 'off'}`}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{r.exposed ? 'ON' : 'OFF'}</span>
                    </button>
                  </td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                    <span className={`badge ${label.cls}`} title={r.statusReason ?? ''}>{label.text}</span>
                    {r.statusReason && <div className="hint" style={{ fontSize: 12, marginTop: 4 }}>{r.statusReason}</div>}
                  </td>
                  <td style={{ wordBreak: 'break-all' }}>
                    {r.exposed && r.status === 'available' ? (
                      <a href={r.address} target="_blank" rel="noreferrer"><code>{r.shortAddress ?? r.address}</code></a>
                    ) : (
                      <code>{r.shortAddress ?? r.address}</code>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.exposed && r.status === 'available' && (
                      <a className="btn primary sm" href={r.address} target="_blank" rel="noreferrer">
                        Open {r.title} ↗
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
