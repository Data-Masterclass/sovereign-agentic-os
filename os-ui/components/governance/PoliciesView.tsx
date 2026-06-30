/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type GrantRow = {
  principal: string;
  tool: string;
  source: 'role' | 'access-grant' | 'egress' | 'standing';
  domain: string;
  compiledTo: 'OPA' | 'Cube' | 'OpenSearch-DLS';
};

type PolicyPlane = {
  plane: GrantRow[];
  sources: { name: string; authoredIn: string; compiledTo: string; rights: string[] }[];
  egress: { endpoint: string; domain: string; approvedBy: string }[];
  standing: {
    id: string;
    kind: string;
    match: string;
    domain: string;
    createdBy: string;
    createdAt: string;
    fromApproval: string;
  }[];
  opaLive: boolean;
  canOverride: boolean;
};

export default function PoliciesView() {
  const [data, setData] = useState<PolicyPlane | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/governance/policies', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load policies');
      else setData(body as PolicyPlane);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = useCallback(
    async (principal: string, tool: string) => {
      const key = `${principal}:${tool}`;
      setBusy(key);
      setError('');
      try {
        const res = await fetch('/api/governance/policies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ principal, tool }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Revoke failed');
        else await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  return (
    <div>
      <div className="section-title">
        Policy plane
        {data && (
          <span className={`badge ${data.opaLive ? 'ok' : 'muted'}`} style={{ marginLeft: 4 }}>
            {data.opaLive ? 'OPA live' : 'compiled (mock)'}
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

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!data && !error && <div className="stub-page">Loading policies…</div>}

      {data && (
        <>
          {/* Access grants table */}
          <div className="section-title">
            Access grants · principal × tool
            <span className="count-pill">{data.plane.length}</span>
          </div>
          {data.plane.length === 0 ? (
            <div className="stub-page">No access grants configured.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Principal</th>
                    <th>Tool</th>
                    <th>Source</th>
                    <th>Domain</th>
                    <th>Compiled to</th>
                    {data.canOverride && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {data.plane.map((row, i) => {
                    const k = `${row.principal}:${row.tool}`;
                    return (
                      <tr key={i}>
                        <td className="mono" style={{ fontWeight: 600 }}>{row.principal}</td>
                        <td className="mono">{row.tool}</td>
                        <td><span className="badge">{row.source}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{row.domain}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{row.compiledTo}</td>
                        {data.canOverride && (
                          <td style={{ textAlign: 'right' }}>
                            <button
                              className="btn ghost"
                              style={{
                                padding: '3px 10px',
                                fontSize: 12,
                                color: 'var(--danger)',
                                borderColor: 'rgba(229,104,95,0.35)',
                              }}
                              disabled={busy === k}
                              onClick={() => revoke(row.principal, row.tool)}
                            >
                              {busy === k ? <span className="spin" /> : 'Revoke'}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Capability profiles */}
          {data.sources.length > 0 && (
            <>
              <div className="section-title">
                Capability profiles
                <span className="count-pill">{data.sources.length}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Profile</th><th>Authored in</th><th>Compiled to</th><th>Rights</th></tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s, i) => (
                      <tr key={i}>
                        <td className="mono" style={{ fontWeight: 600 }}>{s.name}</td>
                        <td style={{ fontSize: 12 }}>{s.authoredIn}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{s.compiledTo}</td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {s.rights.map((r) => (
                              <span key={r} className="chip">{r}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Egress allowlist */}
          {data.egress.length > 0 && (
            <>
              <div className="section-title">
                Egress allowlist
                <span className="count-pill">{data.egress.length}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Endpoint</th><th>Domain</th><th>Approved by</th></tr>
                  </thead>
                  <tbody>
                    {data.egress.map((e, i) => (
                      <tr key={i}>
                        <td className="mono">{e.endpoint}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{e.domain}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{e.approvedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Standing policies */}
          {data.standing.length > 0 && (
            <>
              <div className="section-title">
                Standing policies
                <span className="count-pill">{data.standing.length}</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Match</th>
                      <th>Domain</th>
                      <th>Created by</th>
                      <th>From approval</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.standing.map((p) => (
                      <tr key={p.id}>
                        <td><span className="badge">{p.kind}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.match}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.domain}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.createdBy}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{p.fromApproval || '—'}</td>
                        <td style={{ fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
