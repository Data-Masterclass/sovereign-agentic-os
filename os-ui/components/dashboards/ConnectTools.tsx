/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import ConnectPowerBI from '@/components/powerbi/ConnectPowerBI';

/** The PostgreSQL connection fields the /api/powerbi/connection-info route returns
 *  (Cube SQL API as the `bi_<domain>` principal). Password by vault reference only. */
type ConnectionInfo = {
  enabled: boolean;
  server: string;
  host: string;
  port: number;
  database: string;
  user: string;
  domain: string;
  password: { source: 'vault'; secretName: string; key: string };
  scopeNote: string;
};

type ConnectMeta = { domain: string; supersetUrl: string | null };

/**
 * Tier-2 "connected tools" for the Govern stage. The native dashboard (Tier 1) stays the
 * default; here a builder EXPORTS a governed connection to their own BI tool instead of
 * embedding one:
 *   • Power BI — one-click `.pbids` (server/user pre-filled; password from the vault).
 *   • Tableau  — the same Cube SQL API PostgreSQL connection fields, entered by hand.
 *   • Superset — an "Open in Superset →" link to the external console (only when the
 *     operator configured one).
 * Every tool authenticates as the shared `bi_<domain>` principal → domain-scoped RLS (NOT
 * per-individual). We say so honestly.
 */
export default function ConnectTools() {
  const [meta, setMeta] = useState<ConnectMeta | null>(null);
  const [tableau, setTableau] = useState<ConnectionInfo | null>(null);
  const [tableauErr, setTableauErr] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/dashboards/connect-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ConnectMeta | null) => { if (alive && d) setMeta(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const loadTableau = async () => {
    setTableauErr('');
    try {
      const res = await fetch('/api/powerbi/connection-info', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setTableauErr(data?.error ?? 'Could not load the connection'); return; }
      setTableau(data as ConnectionInfo);
    } catch (e) {
      setTableauErr((e as Error).message);
    }
  };

  const domain = meta?.domain ?? '';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <p className="hint" style={{ marginTop: 0 }}>
        Prefer your own BI tool? Export a <strong>governed connection</strong> instead of embedding one.
        Every tool connects as the domain’s read-only <code>bi_{domain || 'domain'}</code> principal, so
        Cube → Trino → OPA row-level security applies — scoped to the <strong>whole domain</strong>, not
        per-individual (per-viewer RLS is native Tier-1, above).
      </p>

      {/* Power BI — the existing one-click .pbids export, unchanged. */}
      <div className="grant-block">
        <div className="comp-label" style={{ marginBottom: 8 }}>Power BI</div>
        <ConnectPowerBI domain={domain} />
      </div>

      {/* Tableau — the same Cube SQL API PostgreSQL connection, entered by hand. */}
      <div className="grant-block">
        <div className="comp-label" style={{ marginBottom: 8 }}>Tableau</div>
        {tableau ? (
          <div>
            <p className="hint" style={{ marginTop: 0 }}>
              In Tableau: <strong>Connect → PostgreSQL</strong> and enter these. The password is in the
              vault / k8s Secret (<code>{tableau.password.secretName}</code>, key <code>{tableau.password.key}</code>) — never shown here.
            </p>
            <div className="table-wrap">
              <table>
                <tbody>
                  <tr><th>Server</th><td className="mono">{tableau.host}</td></tr>
                  <tr><th>Port</th><td className="mono">{tableau.port}</td></tr>
                  <tr><th>Database</th><td className="mono">{tableau.database}</td></tr>
                  <tr><th>Username</th><td className="mono">{tableau.user}</td></tr>
                  <tr><th>Password</th><td>from vault → <code>{tableau.password.secretName}</code></td></tr>
                </tbody>
              </table>
            </div>
            {!tableau.enabled ? (
              <div className="hint" style={{ marginTop: 8 }}>
                The Cube SQL API is not enabled on this instance — ask your platform admin to enable it and open the ingress port before connecting.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick={loadTableau}>Show Tableau connection</button>
            <span className="hint" style={{ margin: 0 }}>The PostgreSQL fields for the Cube SQL API (server, database, username).</span>
          </div>
        )}
        {tableauErr ? <div className="error" style={{ marginTop: 10 }}>{tableauErr}</div> : null}
      </div>

      {/* Superset — a link to the external console, only when the operator configured one. */}
      {meta?.supersetUrl ? (
        <div className="grant-block">
          <div className="comp-label" style={{ marginBottom: 8 }}>Apache Superset</div>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <a className="btn ghost" href={meta.supersetUrl} target="_blank" rel="noreferrer">Open in Superset →</a>
            <span className="hint" style={{ margin: 0 }}>Explore the same governed Cube views in the Superset console (its own tab).</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
