/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Domain-Builder Workbench launcher. Opens the builder's PERSISTENT, DOMAIN-SCOPED
 * code-server (VS Code in the browser) through the workbench-broker.
 *
 * Flow:
 *   1. POST /api/workbench/session { domain } — the OS server gates on role +
 *      domain membership and mints a short-lived single-use token -> { token,
 *      brokerUrl, domain }.
 *   2. POST `${brokerUrl}/session?t=${token}` (credentials: 'include') — the broker
 *      verifies the token, reconciles + scales up THIS builder's code-server (PVC +
 *      Deployment + Service + per-builder NetworkPolicy + domain-scoped creds), and
 *      sets an HttpOnly proxy cookie binding the browser to {builder, domain}.
 *   3. Point an iframe at `${brokerUrl}/` — every request/WS is reverse-proxied by
 *      the broker to the builder's editor (the browser never reaches the k8s API or
 *      the pod directly). The editor's git/data tools are scoped to this domain.
 */
type Status = 'idle' | 'opening' | 'open' | 'error';

export default function Workbench({ domains }: { domains: string[] }) {
  const [domain, setDomain] = useState<string>(domains[0] ?? '');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const [src, setSrc] = useState<string>('');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const open = useCallback(async () => {
    setStatus('opening');
    setMessage('requesting workbench…');
    setSrc('');

    // 1) Mint a domain-scoped token (server enforces auth + role + membership).
    let token: string;
    let brokerUrl: string;
    try {
      const res = await fetch('/api/workbench/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus('error');
        setMessage(body.error || `session request failed (${res.status})`);
        return;
      }
      ({ token, brokerUrl } = await res.json());
    } catch {
      setStatus('error');
      setMessage('could not reach the workbench session endpoint');
      return;
    }

    // 2) Establish the session at the broker (reconcile + scale up + proxy cookie).
    setMessage('provisioning your editor (this can take a moment on first open)…');
    try {
      const res = await fetch(`${brokerUrl}/session?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus('error');
        setMessage(body.error || `broker rejected the session (${res.status})`);
        return;
      }
    } catch {
      setStatus('error');
      setMessage('could not reach the workbench broker (is it port-forwarded?)');
      return;
    }

    // 3) Load code-server through the broker reverse proxy.
    setSrc(`${brokerUrl}/?folder=/home/coder/project`);
    setStatus('open');
    setMessage('');
  }, [domain]);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="muted" htmlFor="wb-domain">
          Domain
        </label>
        <select
          id="wb-domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          disabled={status === 'opening' || domains.length <= 1}
        >
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button onClick={open} disabled={status === 'opening' || !domain}>
          {status === 'open' ? 'Reopen workbench' : 'Open workbench'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {status === 'opening' && '⟳ '} {message}
        </span>
      </div>

      {status === 'open' && src ? (
        <iframe
          ref={iframeRef}
          src={src}
          title="Domain Builder Workbench"
          style={{ width: '100%', height: '72vh', border: '1px solid #1d2733', borderRadius: 8, background: '#0b0f14' }}
        />
      ) : (
        <div
          className="muted"
          style={{
            height: '72vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed #1d2733',
            borderRadius: 8,
            textAlign: 'center',
            padding: 24,
          }}
        >
          {status === 'error' ? (
            <span style={{ color: '#f08' }}>{message}</span>
          ) : (
            <span>
              Your persistent, domain-scoped editor opens here. Pick a domain and
              click <strong>Open workbench</strong>.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
