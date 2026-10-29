/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  domain: string;
  reason: string;
  detail: unknown;
};

type AuditData = {
  entries: AuditEntry[];
  broken: string | null;
  intact: boolean;
};

export default function AuditLog() {
  const [data, setData] = useState<AuditData | null>(null);
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (action) params.set('action', action);
      const res = await fetch(`/api/governance/audit?${params.toString()}`, {
        cache: 'no-store',
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load audit log');
      else setData(body as AuditData);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [q, action]);

  useEffect(() => {
    load();
  }, [load]);

  const knownActions = data
    ? Array.from(new Set(data.entries.map((e) => e.action))).sort()
    : [];

  return (
    <div>
      <div className="section-title">
        Audit log
        {data && (
          <span className={`badge ${data.intact ? 'ok' : 'err'}`}>
            {data.intact ? 'integrity verified' : 'chain broken'}
          </span>
        )}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {data?.broken && (
        <div className="error" style={{ marginBottom: 10 }}>
          Chain integrity broken: {data.broken}
        </div>
      )}

      <div className="row" style={{ marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <input
          type="text"
          style={{ flex: '1 1 220px', padding: '8px 12px' }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search actors, subjects, reasons…"
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ minWidth: 160 }}
        >
          <option value="">All actions</option>
          {knownActions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}

      {!data && !error && <div className="stub-page">Loading audit log…</div>}

      {data && data.entries.length === 0 && (
        <div className="stub-page">No audit entries match the current filter.</div>
      )}

      {data && data.entries.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Subject</th>
                  <th>Domain</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      {new Date(e.at).toLocaleString()}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.actor}</td>
                    <td><span className="badge">{e.action}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.subject}</td>
                    <td style={{ fontSize: 12 }}>{e.domain}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {data.entries.length} {data.entries.length === 1 ? 'entry' : 'entries'}
            {(q || action) ? ' matching current filter' : ''}
          </div>
        </>
      )}
    </div>
  );
}
