/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { getTerminalSession, type TerminalState } from '@/lib/platform-admin/terminal-session';

/**
 * Terminal tab view. The actual shell (WebSocket + xterm + scrollback) lives in
 * the module-level session manager (lib/terminal-session.ts) and SURVIVES route
 * changes — this component only:
 *
 *   1. auto-connects on mount (no Connect button — opening the tab IS the intent),
 *   2. attaches the persistent terminal surface into its host <div>,
 *   3. renders the honest status line (what the session is waiting on),
 *   4. detaches (NOT disconnects) on unmount, so switching tabs and returning
 *      re-attaches the same live shell with scrollback intact.
 *
 * The session ends on logout (full-page navigation closes the WS => the broker
 * reaps the sandbox pod) or on the broker's generous idle/max-TTL.
 */
const STATUS_LABEL: Record<TerminalState['status'], string> = {
  idle: 'starting',
  connecting: 'connecting',
  ready: 'connected',
  closed: 'disconnected',
  error: 'error',
};

export default function Terminal() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<TerminalState>({ status: 'idle', message: '' });

  useEffect(() => {
    const sess = getTerminalSession();
    const unsub = sess.subscribe(setState);
    if (hostRef.current) sess.attach(hostRef.current);
    void sess.connect(); // idempotent: re-attaches to a live session as-is
    return () => {
      unsub();
      sess.detach(); // detach ONLY — the shell keeps running across tabs
    };
  }, []);

  const showRetry = state.status === 'closed' || state.status === 'error';

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}
      >
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="ico" style={{ color: state.status === 'ready' ? 'var(--teal)' : 'var(--muted)' }}>▮</span>
          <strong>Sandbox shell</strong>
          <span className="muted mono" style={{ fontSize: 11 }}>
            {STATUS_LABEL[state.status]}
            {state.message ? ` — ${state.message}` : ''}
            {state.status === 'ready' ? ' — stays connected while you are signed in' : ''}
          </span>
        </div>
        {showRetry ? (
          <button className="btn" style={{ padding: '5px 12px' }} onClick={() => void getTerminalSession().connect()}>
            Start new shell
          </button>
        ) : null}
      </div>
      <div
        ref={hostRef}
        style={{ height: 460, background: '#0b0f14', padding: '8px 10px' }}
        aria-label="terminal"
      />
    </div>
  );
}
