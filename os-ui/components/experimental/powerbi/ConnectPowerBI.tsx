/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * One-click "Connect Power BI" affordance for a governed dataset or metric.
 *
 * Downloads a `.pbids` file that opens Power BI Desktop with the Cube SQL API
 * pre-configured — server, database and BI username are all filled in. The user
 * only enters the password (retrieved from the vault / k8s Secret separately).
 *
 * RLS note (surfaced in the UI): the `bi_<domain>` principal Cube authenticates maps
 * to a domain-level securityContext. Every viewer of a Power BI report built on this
 * connection sees the same domain-scoped rows. Per-individual RLS (Entra ID JWT
 * federation) is a later phase.
 *
 * SQL API availability gate: if the operator hasn't enabled the SQL API
 * (`CUBE_SQL_API_ENABLED=false`), the download returns 503 and we surface an honest
 * message rather than offering a file that points at a closed port.
 */
export default function ConnectPowerBI({ domain }: { domain: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const url = `/api/powerbi/pbids${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        const msg: string = body?.error ?? res.statusText;
        // 503 = SQL API not enabled — give actionable guidance
        setErr(
          res.status === 503
            ? 'The Cube SQL API is not enabled on this instance. Ask your platform admin to enable it and open the external ingress port before connecting Power BI.'
            : msg,
        );
        return;
      }
      // Trigger browser file download
      const blob = await res.blob();
      const disp = res.headers.get('content-disposition') ?? '';
      const filenameMatch = disp.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? `sovereign-os-bi_${domain}.pbids`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr((e as Error).message ?? 'Download failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <button
          className="btn ghost"
          onClick={download}
          disabled={busy}
          title="Download a .pbids file — open it in Power BI Desktop to connect in one click"
        >
          {busy ? <span className="spin" /> : null}
          {busy ? 'Preparing…' : 'Connect Power BI'}
        </button>

        <div style={{ flex: 1, minWidth: 220 }}>
          <p className="hint" style={{ margin: 0 }}>
            Downloads a <code>.pbids</code> file. Open it in <strong>Power BI Desktop</strong> —
            the server and username are pre-filled. Enter the SQL password when prompted
            (retrieve it from the <code>{`k8s Secret / vault`}</code> — the{' '}
            <strong>connection-info</strong> panel shows where).
          </p>
          <p className="hint" style={{ marginTop: 6 }}>
            Row-level security scopes data to{' '}
            <strong>domain&nbsp;{domain}</strong>. All viewers of a report share this
            domain&nbsp;principal — not per-individual (per-viewer RLS is a later phase via
            Entra&nbsp;ID federation).
          </p>
        </div>
      </div>

      {err ? (
        <div className="error" style={{ marginTop: 10 }}>
          {err}
        </div>
      ) : null}
    </div>
  );
}
