/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * I18N:       converted (wave 2) — texts from `admin.mcpConnect.*`. Code snippets, config JSON and shell
 *             commands shown for copying stay verbatim.
 */
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from '@core/i18n/client';

/**
 * Discovery UX for the overarching OS remote MCP endpoint. Shows the user their
 * personal endpoint URL + bearer token and the exact copy-paste import snippets
 * for Claude and ChatGPT. Apple-clean: one quiet card, the token masked until
 * revealed, one-tap copy. The token is minted server-side (cookie-authenticated)
 * and scoped to this user's live identity; the signing secret never leaves the
 * server.
 */

type TokenResp = { endpoint: string; path: string; token: string; role: string; id: string; name: string };

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useTranslations('admin');
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
      {done ? t('mcpConnect.copied') : (label ?? t('mcpConnect.copy'))}
    </button>
  );
}

const strong = (c: ReactNode) => <strong>{c}</strong>;
const em = (c: ReactNode) => <em>{c}</em>;
const mono = (c: ReactNode) => <span className="mono">{c}</span>;

export default function McpConnect({ tab }: { tab?: string } = {}) {
  const t = useTranslations('admin');
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
        setError(t('mcpConnect.errSession'));
        return;
      }
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('mcpConnect.errMint'));
      else setData(body as TokenResp);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

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

  // Codex (OpenAI CLI) — first-class path for the OpenAI ecosystem. The token is
  // held in a launchctl env var (never in Codex config or a chat); Codex reads it
  // by name via --bearer-token-env-var. Uses the SAME dynamic endpoint/serverName
  // the other snippets use, so it is always correct for this deployment.
  const codexEnvVar = 'SOVEREIGN_AGENTIC_OS_TOKEN';
  const codexSetenv = `launchctl setenv ${codexEnvVar} '${token}'`;
  const codexAdd = `codex mcp add ${serverName} \\\n  --url ${endpoint} \\\n  --bearer-token-env-var ${codexEnvVar}`;
  const codexGet = `codex mcp get ${serverName}`;

  return (
    <div className="card" style={{ marginTop: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{tab ? t('mcpConnect.titleTab') : t('mcpConnect.titleOs')}</strong>
        <span className="pa-tag">{t('mcpConnect.remoteTag')}</span>
      </div>
      <p className="muted" style={{ margin: '8px 0 14px', fontSize: 12.5, maxWidth: 640 }}>
        {tab ? t.rich('mcpConnect.introTab', { em }) : t.rich('mcpConnect.introOs', { em })}
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
                {t.rich('mcpConnect.signedInAs', { id: data.id, role: data.role, mono, strong })}
              </span>
            </span>
          </div>

          <div className="section-title" style={{ marginTop: 2 }}>{t('mcpConnect.step1Title')}</div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 10px', maxWidth: 640 }}>
            {t.rich('mcpConnect.step1Body', { name: data.name || data.id, role: data.role, strong })}
          </p>

          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>{t('mcpConnect.endpointLabel')}</span>
              <div className="row" style={{ gap: 8 }}>
                <input className="mono" readOnly value={endpoint} style={{ flex: 1, color: '#1a1813', background: '#ffffff' }} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={endpoint} />
              </div>
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {t('mcpConnect.tokenLabel')}
              </span>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="mono"
                  readOnly
                  value={reveal ? token : masked}
                  style={{ flex: 1, color: '#1a1813', background: '#ffffff' }}
                  onFocus={(e) => reveal && e.currentTarget.select()}
                />
                <button className="btn ghost" onClick={() => setReveal((v) => !v)}>{reveal ? t('mcpConnect.hide') : t('mcpConnect.reveal')}</button>
                <CopyButton text={token} label={t('mcpConnect.copyToken')} />
              </div>
            </label>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>{t('mcpConnect.step2Title')}</div>
          <ol style={{ margin: '4px 0 4px', paddingLeft: 22, fontSize: 12.5, lineHeight: 1.9, color: 'var(--text)' }}>
            <li>{t.rich('mcpConnect.claudeS1', { strong })}</li>
            <li>{t('mcpConnect.claudeS2')}</li>
            <li>{t.rich('mcpConnect.claudeS3', { strong, em })}</li>
            <li>
              {t.rich('mcpConnect.claudeS4', {
                id: data.id,
                strong,
                mono: (c) => <span className="mono" style={{ fontWeight: 600 }}>{c}</span>,
              })}
            </li>
            <li>{t.rich('mcpConnect.claudeS5', { strong })}</li>
          </ol>

          <p style={{ margin: '10px 0 2px', fontSize: 12.5 }}>
            <strong style={{ color: 'var(--text)' }}>{t('mcpConnect.fallbackTitle')}</strong>
          </p>
          <details style={{ marginTop: 4 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>{t('mcpConnect.showConfig')}</summary>
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 6px' }}>
              {t.rich('mcpConnect.configBody', { file: 'claude_desktop_config.json', mono })}
            </p>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#1a1813', background: '#ffffff' }}>{desktopJson}</pre>
              <CopyButton text={desktopJson} />
            </div>
          </details>

          <div className="section-title" style={{ marginTop: 18 }}>
            {t('mcpConnect.step3Title')} <span className="pa-tag" style={{ marginLeft: 6 }}>{t('mcpConnect.bestForOpenai')}</span>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 8px', maxWidth: 640 }}>
            {t('mcpConnect.codexIntro')}
          </p>
          <ol style={{ margin: '4px 0 4px', paddingLeft: 22, fontSize: 12.5, lineHeight: 1.9, color: 'var(--text)' }}>
            <li>{t.rich('mcpConnect.codexS1', { strong })}</li>
            <li>
              {t('mcpConnect.codexS2')}
              <div className="row" style={{ gap: 8, alignItems: 'flex-start', margin: '6px 0' }}>
                <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#1a1813', background: '#ffffff' }}>{codexSetenv}</pre>
                <CopyButton text={codexSetenv} />
              </div>
            </li>
            <li>
              {t('mcpConnect.codexS3')}
              <div className="row" style={{ gap: 8, alignItems: 'flex-start', margin: '6px 0' }}>
                <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#1a1813', background: '#ffffff' }}>{codexAdd}</pre>
                <CopyButton text={codexAdd} />
              </div>
            </li>
            <li>
              {t.rich('mcpConnect.codexS4', { cmd: '/mcp', server: serverName, strong, mono })}
            </li>
          </ol>
          <details style={{ marginTop: 4 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>{t('mcpConnect.detailsSummary')}</summary>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text)', marginTop: 8, display: 'grid', gap: 6, maxWidth: 660 }}>
              <p style={{ margin: 0 }}>
                {t.rich('mcpConnect.verify', { cmd: codexGet, envVar: codexEnvVar, strong, mono })}
              </p>
              <p style={{ margin: 0 }}>
                {t.rich('mcpConnect.test', { strong, em })}
              </p>
              <p style={{ margin: 0 }}>
                {t.rich('mcpConnect.updating', { cmd: 'launchctl setenv', strong, mono })}
              </p>
              <p style={{ margin: 0 }}>
                {t.rich('mcpConnect.afterRestart', { strong })}
              </p>
              <p style={{ margin: 0 }}>
                {t.rich('mcpConnect.troubleshooting', {
                  removeCmd: `codex mcp remove ${serverName}`,
                  envVar: codexEnvVar,
                  loginCmd: 'codex mcp login',
                  strong,
                  mono,
                })}
              </p>
              <p className="muted" style={{ margin: 0 }}>
                {t('mcpConnect.security')}
              </p>
            </div>
          </details>

          <div className="section-title" style={{ marginTop: 16 }}>{t('mcpConnect.step4Title')}</div>
          <ol style={{ margin: '4px 0 4px', paddingLeft: 22, fontSize: 12.5, lineHeight: 1.9, color: 'var(--text)' }}>
            <li>{t.rich('mcpConnect.chatgptS1', { strong, em })}</li>
            <li>{t.rich('mcpConnect.chatgptS2', { strong })}</li>
            <li>{t.rich('mcpConnect.chatgptS3', { strong })}</li>
            <li>{t.rich('mcpConnect.chatgptS4', { strong })}</li>
            <li>{t('mcpConnect.chatgptS5')}</li>
          </ol>

          <div className="section-title" style={{ marginTop: 16 }}>{t('mcpConnect.step5Title')}</div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>{t('mcpConnect.step5Body')}</p>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#1a1813', background: '#ffffff' }}>{claudeCode}</pre>
            <CopyButton text={claudeCode} />
          </div>

          <div className="hint" style={{ marginTop: 12 }}>
            {t.rich('mcpConnect.lostToken', { envVar: 'OS_MCP_TOKEN_SECRET', mono })}
          </div>
        </>
      ) : !error ? (
        <div className="hint">{t('mcpConnect.minting')}</div>

      ) : null}
    </div>
  );
}
