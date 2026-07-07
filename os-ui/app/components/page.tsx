/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useToolWindow } from '@/components/ToolWindowProvider';
import { useApi } from '@/lib/useApi';
import { renderMarkdown } from '@/lib/markdown';

/**
 * Components — THE one operator surface for the stack (nav consolidation).
 *
 * One calm list, grouped by the registry's layers: every component with live
 * status (8s poll), version, and its actions folded into the row —
 *   • "Open UI" — the per-component console (same-origin /tools/<key> overlay
 *     where registered, else the native URL). This is what /consoles offered.
 *   • "Open Dagster" — the orchestrator console on the Dagster row (what
 *     /orchestration offered; renders the configured URL / honest state).
 *   • the LiteLLM row carries the model gateway diagnostics (model catalog +
 *     MCP tool count from /api/gateway) in its expandable detail — what
 *     /gateway offered.
 * A row expands to the quiet details: access (port-forward + URL), login,
 * docs, native console link. The /api/platform/* routes are served natively by
 * the OS UI server; the browser never touches a Kubernetes credential.
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
  version: string;
  consoleUrl: string;
};

type GatewayModel = { id: string; ownedBy: string };
type GatewayTool = { name: string; description: string; params: string[] };
type GatewayData = {
  models: GatewayModel[];
  tools: GatewayTool[];
  modelsError: string;
  toolsError: string;
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

/** Same-origin console overlay keys (lib/tool-proxy.ts registry), by component id. */
const TOOL_KEYS: Record<string, string> = {
  superset: 'superset',
  langfuse: 'langfuse',
  openmetadata: 'openmetadata',
  dagster: 'dagster',
  forgejo: 'forgejo',
  mlflow: 'mlflow',
  cube: 'cube',
  jupyterhub: 'jupyterhub',
  featureform: 'featureform',
  'opensearch-dashboards': 'opensearch',
};

/** The one row-level console action a component gets. */
function openLabel(id: string): string {
  return id === 'dagster' ? 'Open Dagster' : 'Open UI';
}

export default function ComponentsPage() {
  const [components, setComponents] = useState<Component[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const { openTool } = useToolWindow();

  // Model gateway diagnostics (folded-in /gateway surface) — one fetch, shown
  // on the LiteLLM row. Errors render as an honest note, never a broken row.
  const gw = useApi<GatewayData>('/api/gateway');

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

  /** The quiet one-line sub-text under a component name. */
  function subline(c: Component): string {
    if (c.id === 'litellm') {
      if (gw.data) {
        const m = gw.data.modelsError ? 'models unreachable' : `${gw.data.models.length} models`;
        const t = gw.data.toolsError ? 'MCP unreachable' : `${gw.data.tools.length} MCP tools`;
        return `Model gateway — ${m} · ${t}`;
      }
      if (gw.error) return 'Model gateway — diagnostics unreachable';
    }
    return c.summary;
  }

  return (
    <>
      <PageHeader title="Components" crumb="the stack, live — one operator surface" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Every component in the stack with <strong>live status</strong>, refreshed every
            8&nbsp;seconds. Open a tool&apos;s console straight from its row; expand a row for
            its address, login, docs, and diagnostics. Switching a workload off scales
            it&nbsp;0↔1; <em>disabled</em> means it isn&apos;t installed in this deployment.
            Core services can&apos;t be switched off.
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
            <div className="comp-list">
              {(components ?? [])
                .filter((c) => c.layer === layer)
                .map((c) => {
                  const b = badgeFor(c.status);
                  const open = openId === c.id;
                  const on = isUp(c.status);
                  const toolKey = TOOL_KEYS[c.id];
                  const localUrl =
                    c.ui && c.lport ? `http://localhost:${c.lport}${c.url_path ?? ''}` : '';
                  const pf = c.svc
                    ? `kubectl -n ${c.ns} port-forward svc/${c.svc} ${c.lport}:${c.port}`
                    : '';
                  return (
                    <div className={`comp-item${open ? ' open' : ''}`} key={c.id}>
                      <div className="comp-row">
                        <button
                          type="button"
                          className="comp-expand"
                          onClick={() => setOpenId(open ? null : c.id)}
                          aria-expanded={open}
                          aria-label={`${c.name} details`}
                        >
                          <span className={`comp-dot ${b.cls}`} />
                          <span className="comp-name">{c.name}</span>
                          {c.version && c.version !== 'n/a' ? (
                            <span className="comp-ver mono">{c.version}</span>
                          ) : null}
                          <span className="comp-blurb muted">{subline(c)}</span>
                        </button>
                        <span className={`badge ${b.cls}`}>{b.label}</span>
                        {toolKey ? (
                          <button
                            className="btn ghost sm"
                            onClick={() => openTool(toolKey, c.name)}
                          >
                            {openLabel(c.id)}
                          </button>
                        ) : c.consoleUrl ? (
                          <a
                            className="btn ghost sm"
                            href={c.consoleUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {openLabel(c.id)} ↗
                          </a>
                        ) : null}
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

                      {open ? (
                        <div className="comp-detail">
                          <div className="muted comp-summary">{c.summary}</div>

                          {c.id === 'litellm' ? (
                            <GatewayDetail gw={gw.data} gwError={gw.error} />
                          ) : null}

                          <div className="comp-meta">
                            <span className="comp-label">Access</span>
                            {pf ? <div className="codeblock">{pf}</div> : <span className="muted">—</span>}
                            {localUrl ? <div className="comp-url mono">{localUrl}</div> : null}
                          </div>

                          <div className="comp-meta">
                            <span className="comp-label">Login</span>
                            <span className="comp-login mono">{c.login}</span>
                          </div>

                          <div className="comp-actions">
                            <button className="btn ghost sm" onClick={() => openDoc(c)}>
                              Docs
                            </button>
                            {toolKey && c.consoleUrl ? (
                              <a
                                className="btn ghost sm"
                                href={c.consoleUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Native console ↗
                              </a>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
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

/**
 * The folded-in model gateway diagnostics (formerly the /gateway page): the
 * LiteLLM model catalog + registered MCP tools, honest per-section errors.
 */
function GatewayDetail({ gw, gwError }: { gw: GatewayData | null; gwError: string }) {
  if (!gw) {
    return (
      <div className="comp-meta">
        <span className="comp-label">Model gateway</span>
        <span className="muted">
          {gwError
            ? 'Diagnostics unreachable — LiteLLM may be down. Port-forward: '
            : 'Loading diagnostics… '}
          {gwError ? (
            <code>kubectl -n agentic-os port-forward svc/agentic-os-litellm 4000:4000</code>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <>
      <div className="comp-meta">
        <span className="comp-label">Models ({gw.modelsError ? '—' : gw.models.length})</span>
        {gw.modelsError ? (
          <span className="muted">{gw.modelsError}</span>
        ) : gw.models.length === 0 ? (
          <span className="muted">No models registered.</span>
        ) : (
          <div className="comp-chiprow">
            {gw.models.map((m) => (
              <span className="chip mono" key={m.id} title={`owned by ${m.ownedBy || 'unknown'}`}>
                {m.id}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="comp-meta">
        <span className="comp-label">MCP tools ({gw.toolsError ? '—' : gw.tools.length})</span>
        {gw.toolsError ? (
          <span className="muted">{gw.toolsError}</span>
        ) : gw.tools.length === 0 ? (
          <span className="muted">No MCP tools registered.</span>
        ) : (
          <ul className="comp-toollist">
            {gw.tools.map((t) => (
              <li key={t.name}>
                <span className="mono">{t.name}</span>
                <span className="muted"> — {t.description || 'No description.'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
