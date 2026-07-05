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

type TokenResp = { endpoint: string; path: string; token: string; role: string; id: string; name: string };

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
      if (res.status === 401 || res.status === 403) {
        // Not a scary error — the cookie session lapsed. Guide, don't alarm.
        setData(null);
        setError('Your session expired. Refresh the page (and sign in again if asked), then reopen this panel.');
        return;
      }
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
          <div
            className="row"
            style={{
              gap: 10,
              alignItems: 'center',
              background: '#faf8f3',
              border: '1px solid #ece7dc',
              borderRadius: 10,
              padding: '10px 12px',
              marginBottom: 14,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: '#1a1813',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {(data.name || data.id || '?').slice(0, 1).toUpperCase()}
            </span>
            <span style={{ display: 'grid', lineHeight: 1.35 }}>
              <strong style={{ fontSize: 13.5 }}>{data.name || data.id}</strong>
              <span className="muted" style={{ fontSize: 11.5 }}>
                Signed in as <span className="mono">{data.id}</span> · role <strong>{data.role}</strong>
              </span>
            </span>
          </div>

          <div className="section-title" style={{ marginTop: 2 }}>1 · Your connection (works with any AI platform)</div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 10px', maxWidth: 640 }}>
            Every AI platform connects the same way: it needs your <strong>endpoint URL</strong>, and a way to
            prove it&rsquo;s you — either <strong>managed sign-in</strong> (the platform sends you to this OS to log in;
            nothing to copy) or your <strong>personal token</strong> (for platforms that use access-token auth).
            Both connect as <strong>{data.name || data.id}</strong> ({data.role}) — same identity, same governance.
          </p>

          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>Endpoint URL — every platform needs this</span>
              <div className="row" style={{ gap: 8 }}>
                <input className="mono" readOnly value={endpoint} style={{ flex: 1, color: '#1a1813', background: '#ffffff' }} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={endpoint} />
              </div>
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>
                Personal token — only for token-based platforms (e.g. ChatGPT) · treat like a password
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="mono"
                  readOnly
                  value={reveal ? token : masked}
                  style={{ flex: 1, color: '#1a1813', background: '#ffffff' }}
                  onFocus={(e) => reveal && e.currentTarget.select()}
                />
                <button className="btn ghost" onClick={() => setReveal((v) => !v)}>{reveal ? 'Hide' : 'Reveal'}</button>
                <CopyButton text={token} label="Copy token" />
              </div>
            </label>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>2 · Connect from Claude (Desktop or claude.ai)</div>
          <ol style={{ margin: '4px 0 4px', paddingLeft: 22, fontSize: 12.5, lineHeight: 1.9, color: '#1a1813' }}>
            <li>Open <strong>Settings</strong> → <strong>Connectors</strong> → <strong>Add custom connector</strong>.</li>
            <li>Paste the endpoint URL. Leave everything else empty.</li>
            <li>Choose <strong>Managed Authorization</strong> (<em>Verwaltete Autorisierung</em>) — no token needed.</li>
            <li>
              A sign-in window from this OS opens. Sign in with <strong>your OS account</strong>:
              username <span className="mono" style={{ fontWeight: 600 }}>{data.id}</span>, your usual OS password.
            </li>
            <li>Click <strong>Approve</strong>. Done — revocable any time from this OS.</li>
          </ol>

          <div className="section-title" style={{ marginTop: 16 }}>2 · Connect from ChatGPT</div>
          <ol style={{ margin: '4px 0 4px', paddingLeft: 22, fontSize: 12.5, lineHeight: 1.9, color: '#1a1813' }}>
            <li>Open <strong>Settings</strong> → <strong>Connectors</strong> (enable <em>Developer mode</em> if asked).</li>
            <li>Click <strong>Add custom connector</strong> and give it a name (e.g. &ldquo;Sovereign OS&rdquo;).</li>
            <li>Paste the endpoint URL as the <strong>MCP Server URL</strong>.</li>
            <li>Authentication → <strong>Access token / API key</strong> → paste your <strong>personal token</strong> from above.</li>
            <li>Save, then enable it in the chat composer&rsquo;s tools. ChatGPT now works as you, fully governed.</li>
          </ol>

          <div className="section-title" style={{ marginTop: 16 }}>2 · Connect from Claude Code (terminal)</div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>One command — paste into your terminal:</p>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#1a1813', background: '#ffffff' }}>{claudeCode}</pre>
            <CopyButton text={claudeCode} />
          </div>

          <details style={{ marginTop: 16 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
              Config-file fallback — only for older Claude Desktop versions without custom connectors
            </summary>
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 6px' }}>
              Add to <span className="mono">claude_desktop_config.json</span> (Settings → Developer → Edit Config),
              then restart Claude.
            </p>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#1a1813', background: '#ffffff' }}>{desktopJson}</pre>
              <CopyButton text={desktopJson} />
            </div>
          </details>

          <div className="hint" style={{ marginTop: 12 }}>
            Lost or leaked your token? An operator rotates <span className="mono">OS_MCP_TOKEN_SECRET</span> to
            revoke all tokens; reload this page for a fresh one. Managed sign-ins are unaffected.
          </div>
        </>
      ) : !error ? (
        <div className="hint">Minting your token…</div>
      ) : null}
    </div>
  );
}
