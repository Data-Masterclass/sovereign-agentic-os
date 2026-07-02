/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Discovery UX for the overarching OS remote MCP endpoint. Shows the user their
 * personal endpoint URL + bearer token and the exact copy-paste import snippets
 * for Claude and ChatGPT. Apple-clean: one quiet card, the token masked until
 * revealed, one-tap copy. The token is minted server-side (cookie-authenticated)
 * and scoped to this user's live identity; the signing secret never leaves the
 * server.
 */

type TokenResp = { endpoint: string; path: string; token: string; role: string };

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked — the field is selectable anyway */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export default function McpConnect({ tab }: { tab?: string } = {}) {
  const [data, setData] = useState<TokenResp | null>(null);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/mcp/token', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to mint a token');
      else setData(body as TokenResp);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Prefer the server-provided absolute endpoint (OS_PUBLIC_URL); otherwise build
  // an absolute URL from the browser origin so the copied snippet is pasteable.
  // A `tab` scopes the same token to that tab's filtered MCP view (/api/mcp/<tab>).
  const suffix = tab ? `/${tab}` : '';
  const endpoint = data
    ? `${data.endpoint || (typeof window !== 'undefined' ? `${window.location.origin}${data.path}` : data.path)}${suffix}`
    : '';
  const serverName = tab ? `sovereign-os-${tab}` : 'sovereign-os';
  const token = data?.token ?? '';
  const masked = token ? `${token.slice(0, 12)}${'•'.repeat(18)}${token.slice(-4)}` : '';

  const claudeCode = `claude mcp add --transport http ${serverName} ${endpoint} \\\n  --header "Authorization: Bearer ${token}"`;
  const desktopJson = `{
  "mcpServers": {
    "${serverName}": {
      "command": "npx",
      "args": ["mcp-remote", "${endpoint}",
        "--header", "Authorization: Bearer ${token}"]
    }
  }
}`;

  return (
    <div className="card" style={{ marginTop: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{tab ? `Run this tab from Claude & ChatGPT` : 'Run the OS from Claude & ChatGPT'}</strong>
        <span className="pa-tag">remote MCP</span>
      </div>
      <p className="muted" style={{ margin: '8px 0 14px', fontSize: 12.5, maxWidth: 640 }}>
        {tab ? (
          <>
            Import this endpoint to drive <em>only this tab&rsquo;s</em> tools from your assistant —
            a scoped view of the OS MCP. Every call runs under <em>your</em> identity through the
            same governed path as the UI (OPA policy, audit, role gates); tools are scoped to your
            role. For the whole OS, use the endpoint on the Gateway tab.
          </>
        ) : (
          <>
            Import this one authenticated endpoint once and drive the whole OS — create → build →
            preview → deploy, query the marts, score models — from your assistant. Every call runs
            under <em>your</em> identity through the same governed path as the UI (OPA policy,
            audit, role gates). Your tools are scoped to your role.
          </>
        )}
      </p>

      {error ? <div className="error">{error}</div> : null}

      {data ? (
        <>
          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>Endpoint URL</span>
              <div className="row" style={{ gap: 8 }}>
                <input className="mono" readOnly value={endpoint} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={endpoint} />
              </div>
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>
                Personal token · role <strong>{data.role}</strong> — treat it like a password
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="mono"
                  readOnly
                  value={reveal ? token : masked}
                  style={{ flex: 1 }}
                  onFocus={(e) => reveal && e.currentTarget.select()}
                />
                <button className="btn ghost" onClick={() => setReveal((v) => !v)}>{reveal ? 'Hide' : 'Reveal'}</button>
                <CopyButton text={token} label="Copy token" />
              </div>
            </label>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>Claude Code</div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{claudeCode}</pre>
            <CopyButton text={claudeCode} />
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>Claude Desktop</div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
            Add to <span className="mono">claude_desktop_config.json</span> (Settings → Developer → Edit Config),
            then restart Claude. The <span className="mono">mcp-remote</span> bridge carries the bearer header.
          </p>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{desktopJson}</pre>
            <CopyButton text={desktopJson} />
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>ChatGPT</div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
            Settings → Connectors → <strong>Add custom connector</strong> (Developer mode). Set{' '}
            <strong>MCP Server URL</strong> to the endpoint above, Authentication → <strong>Access token / API key</strong>,
            and paste the token. Save, then enable it in the composer&rsquo;s tools.
          </p>

          <div className="hint" style={{ marginTop: 12 }}>
            Lost or leaked your token? An operator rotates <span className="mono">OS_MCP_TOKEN_SECRET</span> to
            revoke all tokens; reload this page for a fresh one.
          </div>
        </>
      ) : !error ? (
        <div className="hint">Minting your token…</div>
      ) : null}
    </div>
  );
}
