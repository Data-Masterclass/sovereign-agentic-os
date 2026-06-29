/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';

/**
 * xterm.js terminal wired to the terminal-broker over a WebSocket.
 *
 * Flow: POST /api/terminal/token (server gates on role) -> { token, wsUrl } ->
 * open WebSocket(`${wsUrl}?t=${token}`). The broker spawns a locked-down sandbox
 * Pod and bridges its PTY. Keystrokes are sent as BINARY frames (so they are
 * never confused with the JSON control frames we send for resize); terminal
 * output arrives as binary frames; broker status/errors arrive as JSON text.
 *
 * xterm + its addons are imported dynamically (browser-only; they touch the DOM)
 * so the module never runs during SSR.
 */
type Status = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export default function Terminal() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const cleanupRef = useRef<() => void>(() => {});

  const connect = useCallback(async () => {
    // Tear down any prior session first so a reconnect never leaks the previous
    // XTerm instance / WebSocket / listeners (onclose + onerror re-show Connect).
    cleanupRef.current();
    cleanupRef.current = () => {};

    setStatus('connecting');
    setMessage('requesting session…');

    // 1) Mint a short-lived token (server enforces auth + role).
    let token: string;
    let wsUrl: string;
    try {
      const res = await fetch('/api/terminal/token', { method: 'POST', cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus('error');
        setMessage(body.error || `token request failed (${res.status})`);
        return;
      }
      ({ token, wsUrl } = await res.json());
    } catch {
      setStatus('error');
      setMessage('could not reach the token endpoint');
      return;
    }

    // 2) Dynamically import xterm (browser-only). Everything from here through the
    // WebSocket open can throw (chunk-load failure offline, malformed wsUrl), so
    // guard it — otherwise a rejection leaves the UI stuck on 'connecting'.
    try {
    const [{ Terminal: XTerm }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
    ]);

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0b0f14', foreground: '#d6deeb' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    if (hostRef.current) {
      hostRef.current.innerHTML = '';
      term.open(hostRef.current);
      fit.fit();
    }

    // 3) Open the broker WebSocket.
    const sep = wsUrl.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${wsUrl}${sep}t=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const sendResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* ignore */
      }
    };

    ws.onopen = () => {
      setStatus('connected');
      setMessage('');
      sendResize();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // JSON control frame (status / error / closed).
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'status') term.writeln(`\x1b[36m• ${msg.message}\x1b[0m`);
          else if (msg.type === 'error') term.writeln(`\x1b[31m✖ ${msg.message}\x1b[0m`);
          else if (msg.type === 'closed') term.writeln(`\r\n\x1b[33m• session ended (${msg.reason})\x1b[0m`);
        } catch {
          term.write(ev.data);
        }
        return;
      }
      // Binary terminal output.
      term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => {
      setStatus('error');
      setMessage('websocket error (is the broker reachable?)');
    };
    ws.onclose = () => {
      setStatus('closed');
    };

    // Keystrokes -> broker as BINARY (never confused with JSON control frames).
    const dataDisp = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });

    const onWinResize = () => sendResize();
    window.addEventListener('resize', onWinResize);

    cleanupRef.current = () => {
      window.removeEventListener('resize', onWinResize);
      dataDisp.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
      void dec; // (decoder kept for symmetry / future text-frame handling)
    };
    } catch {
      // xterm chunk-load / WebSocket construction failed — surface it instead of
      // leaving the UI stuck on 'connecting' forever.
      setStatus('error');
      setMessage('failed to start the terminal session');
    }
  }, []);

  const disconnect = useCallback(() => {
    cleanupRef.current();
    cleanupRef.current = () => {};
    wsRef.current = null;
    setStatus('idle');
    setMessage('');
  }, []);

  useEffect(() => () => cleanupRef.current(), []);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}
      >
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="ico" style={{ color: 'var(--teal)' }}>▮</span>
          <strong>Sandbox shell</strong>
          <span className="muted mono" style={{ fontSize: 11 }}>
            {status}
            {message ? ` — ${message}` : ''}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {status === 'connected' || status === 'connecting' ? (
            <button className="btn ghost" style={{ padding: '5px 12px' }} onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <button className="btn" style={{ padding: '5px 12px' }} onClick={connect}>
              Connect
            </button>
          )}
        </div>
      </div>
      <div
        ref={hostRef}
        style={{ height: 460, background: '#0b0f14', padding: '8px 10px' }}
        aria-label="terminal"
      />
    </div>
  );
}
