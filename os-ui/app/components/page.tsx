/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { renderMarkdown } from '@/lib/markdown';

/**
 * Components surface — the Admin Console, inside the OS UI.
 *
 * Lists every stack component with live status, lets you switch toggleable
 * workloads on/off (scale 0<->1), and surfaces each one's address (the
 * port-forward command + URL), login, and docs. The /api/platform/* routes
 * are served NATIVELY by the OS UI server (it reads the in-cluster Kubernetes
 * API + the baked-in docs/components/*.md directly) — the browser never touches
 * any Kubernetes credential, and there is no separate admin-console service.
 */

type Component = {
  id: string;
  name: string;
  layer: string;
  status: 'running' | 'starting' | 'off' | 'disabled' | 'n/a' | 'unknown' | string;
  svc: string;
  port: number;
  ns: string;
  lport: number;
  ui: boolean;
  url_path?: string;
  login: string;
  summary: string;
  toggle: boolean;
};

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  running: { cls: 'b-running', label: 'running' },
  starting: { cls: 'b-starting', label: 'starting' },
  off: { cls: 'b-off', label: 'off' },
  disabled: { cls: 'b-disabled', label: 'disabled' },
  'n/a': { cls: 'b-na', label: 'n/a' },
  unknown: { cls: 'b-unknown', label: 'unknown' },
};

function badgeFor(status: string) {
  return STATUS_BADGE[status] ?? { cls: 'b-unknown', label: status };
}

function isUp(status: string) {
  return status === 'running' || status === 'starting';
}

export default function ComponentsPage() {
  const [components, setComponents] = useState<Component[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState('');

  // Docs side panel
  const [docId, setDocId] = useState<string | null>(null);
  const [docName, setDocName] = useState('');
  const [docHtml, setDocHtml] = useState('');
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState('');

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch('/api/platform/components', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      else {
        setComponents(body.components as Component[]);
        setError('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + 8s poll for live status.
  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 8000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = useCallback(
    async (c: Component) => {
      if (!c.toggle || pending[c.id]) return;
      setPending((p) => ({ ...p, [c.id]: true }));
      // Optimistic: flip to a transitional state immediately.
      const optimistic = isUp(c.status) ? 'off' : 'starting';
      setComponents((cs) =>
        cs ? cs.map((x) => (x.id === c.id ? { ...x, status: optimistic } : x)) : cs,
      );
      try {
        const res = await fetch('/api/platform/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: c.id }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          setToast(`${c.name}: ${data.error ?? data.msg ?? 'toggle failed'}`);
        } else {
          setToast(`${c.name}: ${data.msg ?? 'ok'}`);
        }
      } catch (e) {
        setToast(`${c.name}: ${(e as Error).message}`);
      } finally {
        setPending((p) => ({ ...p, [c.id]: false }));
        // Re-sync real status shortly after the scale request lands.
        setTimeout(() => load(false), 1200);
      }
    },
    [pending, load],
  );

  const openDoc = useCallback(async (c: Component) => {
    setDocId(c.id);
    setDocName(c.name);
    setDocHtml('');
    setDocError('');
    setDocLoading(true);
    try {
      const res = await fetch(`/api/platform/doc?id=${encodeURIComponent(c.id)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try {
          msg = (await res.json()).error ?? msg;
        } catch {
          /* keep default */
        }
        setDocError(msg);
      } else {
        setDocHtml(renderMarkdown(await res.text()));
      }
    } catch (e) {
      setDocError((e as Error).message);
    } finally {
      setDocLoading(false);
    }
  }, []);

  const closeDoc = useCallback(() => setDocId(null), []);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Preserve registry order of layers (first-seen wins).
  const layers: string[] = [];
  for (const c of components ?? []) {
    if (!layers.includes(c.layer)) layers.push(c.layer);
  }

  const total = components?.length ?? 0;
  const up = (components ?? []).filter((c) => isUp(c.status)).length;

  return (
    <>
      <PageHeader title="Components" crumb="stack control plane — Admin Console" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Every component in the stack with <strong>live status</strong>, refreshed every
            8&nbsp;seconds. Switch a workload on or off to scale it&nbsp;0↔1; each card shows
            its <strong>address</strong> (the port-forward command and URL), <strong>login</strong>,
            and <strong>docs</strong>. <em>Off</em> means the workload exists but is scaled to
            zero; <em>disabled</em> means it isn&apos;t installed in this deployment. Core
            services can&apos;t be switched off.
          </p>
          <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {components && total > 0 ? (
          <div className="hint" style={{ marginTop: 14 }}>
            {up}/{total} running · {total} components registered
          </div>
        ) : null}

        {!components && loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading components…</div>
        ) : null}

        {layers.map((layer) => (
          <div key={layer}>
            <div className="section-title">{layer}</div>
            <div className="grid comp-grid">
              {(components ?? [])
                .filter((c) => c.layer === layer)
                .map((c) => {
                  const b = badgeFor(c.status);
                  const url = c.ui && c.lport
                    ? `http://localhost:${c.lport}${c.url_path ?? ''}`
                    : '';
                  const pf = c.svc
                    ? `kubectl -n ${c.ns} port-forward svc/${c.svc} ${c.lport}:${c.port}`
                    : '';
                  const on = isUp(c.status);
                  return (
                    <div className="card comp-card" key={c.id}>
                      <div className="comp-head">
                        <span className={`comp-dot ${b.cls}`} />
                        <span className="comp-name">{c.name}</span>
                        <span className={`badge ${b.cls}`}>{b.label}</span>
                      </div>
                      <div className="muted comp-summary">{c.summary}</div>

                      <div className="comp-meta">
                        <span className="comp-label">Access</span>
                        {pf ? (
                          <div className="codeblock">{pf}</div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                        {url ? (
                          <div className="comp-url mono">{url}</div>
                        ) : null}
                      </div>

                      <div className="comp-meta">
                        <span className="comp-label">Login</span>
                        <span className="comp-login mono">{c.login}</span>
                      </div>

                      <div className="comp-actions">
                        <button className="btn ghost sm" onClick={() => openDoc(c)}>
                          Docs
                        </button>
                        {c.toggle ? (
                          <button
                            className={`switch${on ? ' on' : ''}`}
                            role="switch"
                            aria-checked={on}
                            aria-label={`Turn ${c.name} ${on ? 'off' : 'on'}`}
                            disabled={!!pending[c.id]}
                            onClick={() => toggle(c)}
                          >
                            <span className="switch-track">
                              <span className="switch-thumb" />
                            </span>
                            <span className="switch-text">
                              {pending[c.id] ? '…' : on ? 'On' : 'Off'}
                            </span>
                          </button>
                        ) : (
                          <span className="chip comp-core" title="Core service — always on">
                            core
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      {toast ? <div className="comp-toast">{toast}</div> : null}

      {docId ? (
        <div className="drawer-backdrop" onClick={closeDoc}>
          <aside
            className="drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={`${docName} documentation`}
          >
            <div className="drawer-head">
              <h2>{docName}</h2>
              <button className="drawer-x" onClick={closeDoc} aria-label="Close">
                ×
              </button>
            </div>
            <div className="drawer-body">
              {docLoading ? (
                <div className="stub-page"><span className="spin" /> Loading docs…</div>
              ) : docError ? (
                <div className="error">{docError}</div>
              ) : (
                <div className="md-body" dangerouslySetInnerHTML={{ __html: docHtml }} />
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
