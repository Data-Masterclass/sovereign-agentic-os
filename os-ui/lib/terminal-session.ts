/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Module-level terminal session manager — the shell OUTLIVES the /terminal page.
 *
 * Why this shape: the Terminal tab must auto-connect on open and the SAME live
 * shell (WebSocket + PTY + scrollback) must survive in-app navigation. React
 * unmounts the page component on every route change, so the socket and the
 * xterm instance cannot live in component state. Instead this singleton owns:
 *
 *   - the WebSocket to the terminal-broker,
 *   - the XTerm instance, opened ONCE into a detached container <div>,
 *   - the session status (subscribed to by the page component for its header).
 *
 * The page component only ATTACHES the container into its host on mount and
 * DETACHES it on unmount (moving a plain <div> keeps xterm + WS fully alive —
 * unlike an iframe, nothing reloads). Revisiting /terminal re-attaches the
 * very same session: same shell, scrollback intact, zero reconnect.
 *
 * Lifetime: the session lives until (a) the user logs out — sign-out is a
 * full-page navigation, which destroys this module and closes the WS, so the
 * broker reaps the sandbox pod immediately — or (b) the broker's idle/max-TTL
 * (generous: hours, chart values). On a later visit after (b), connect() is
 * idempotent-per-state and simply starts a fresh shell.
 *
 * Browser-only: never import from server code. All DOM/WebSocket work happens
 * inside methods called from client components' effects.
 */

export type TerminalStatus = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
export interface TerminalState {
  status: TerminalStatus;
  message: string;
}

type XTermish = {
  cols: number;
  rows: number;
  write(d: string | Uint8Array): void;
  writeln(d: string): void;
  focus(): void;
  onData(cb: (d: string) => void): { dispose(): void };
  open(el: HTMLElement): void;
  loadAddon(a: unknown): void;
};
type Fitish = { fit(): void };

class TerminalSession {
  private container: HTMLDivElement;
  private term: XTermish | null = null;
  private fit: Fitish | null = null;
  private ws: WebSocket | null = null;
  private dataDisp: { dispose(): void } | null = null;
  private listeners = new Set<(s: TerminalState) => void>();
  private connecting = false;
  state: TerminalState = { status: 'idle', message: '' };

  constructor() {
    this.container = document.createElement('div');
    this.container.style.height = '100%';
    // Refit on window resize whenever the terminal is actually on screen.
    window.addEventListener('resize', () => this.refit());
  }

  subscribe(cb: (s: TerminalState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  private set(status: TerminalStatus, message = '') {
    this.state = { status, message };
    for (const cb of this.listeners) cb(this.state);
  }

  /** Mount the (persistent) terminal surface into the page's host element. */
  attach(host: HTMLElement) {
    if (this.container.parentElement !== host) host.appendChild(this.container);
    this.refit();
    if (this.state.status === 'ready') this.term?.focus();
  }

  /** Unmount from the page WITHOUT touching the WS/xterm — session stays live. */
  detach() {
    this.container.remove();
  }

  private refit() {
    if (!this.container.isConnected) return;
    try {
      this.fit?.fit();
      if (this.ws?.readyState === WebSocket.OPEN && this.term) {
        this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Ensure a live session. Idempotent: a no-op while connecting or connected,
   * so the page can call it on every mount (auto-connect, no button).
   */
  async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.connecting = true;
    this.set('connecting', 'requesting session…');

    try {
      // 1) Short-lived single-use token (server re-checks auth + role).
      let token: string;
      let wsUrl: string;
      const res = await fetch('/api/terminal/token', { method: 'POST', cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.set('error', body.error || `token request failed (${res.status})`);
        return;
      }
      ({ token, wsUrl } = await res.json());

      // 2) xterm (browser-only chunks) — created once, reused across reconnects
      // so scrollback survives a broker-side session expiry + fresh shell.
      if (!this.term) {
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
        term.open(this.container);
        this.term = term as unknown as XTermish;
        this.fit = fit;
      }
      this.refit();

      // 3) Broker WebSocket. Output = binary frames; control = JSON text.
      const sep = wsUrl.includes('?') ? '&' : '?';
      const ws = new WebSocket(`${wsUrl}${sep}t=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const term = this.term!;
      const enc = new TextEncoder();

      ws.onopen = () => {
        this.set('connecting', 'provisioning sandbox…');
        this.refit();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'status') {
              this.set('connecting', msg.message);
              term.writeln(`\x1b[36m• ${msg.message}\x1b[0m`);
            } else if (msg.type === 'ready') {
              // Shell attached: typeable NOW — flip state and grab focus.
              this.set('ready');
              if (this.container.isConnected) term.focus();
            } else if (msg.type === 'error') {
              this.set('error', msg.message);
              term.writeln(`\x1b[31m✖ ${msg.message}\x1b[0m`);
            } else if (msg.type === 'closed') {
              term.writeln(`\r\n\x1b[33m• session ended (${msg.reason})\x1b[0m`);
            } else {
              term.write(ev.data);
            }
          } catch {
            term.write(ev.data);
          }
          return;
        }
        // Binary terminal output. Older brokers send no 'ready' control frame,
        // so the first output also promotes the state (and focuses).
        if (this.state.status !== 'ready' && this.state.status !== 'error') {
          this.set('ready');
          if (this.container.isConnected) term.focus();
        }
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onerror = () => {
        if (this.state.status !== 'error') {
          this.set('error', 'websocket error (is the terminal broker reachable?)');
        }
      };
      ws.onclose = () => {
        this.dataDisp?.dispose();
        this.dataDisp = null;
        this.ws = null;
        if (this.state.status !== 'error') {
          this.set('closed', 'session ended');
        }
      };

      // Keystrokes -> broker as BINARY (never confused with JSON control frames).
      this.dataDisp?.dispose();
      this.dataDisp = term.onData((d) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
      });
    } catch {
      this.set('error', 'failed to start the terminal session');
    } finally {
      this.connecting = false;
    }
  }

  /** Hard teardown (kills the shell). Not used by navigation — only explicit. */
  destroy() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.set('idle');
  }
}

// Singleton on globalThis so Next.js HMR/module re-evaluation in dev never
// duplicates live sessions. In production this is a plain module singleton.
declare global {
  // eslint-disable-next-line no-var
  var __soaTerminalSession: TerminalSession | undefined;
}

export function getTerminalSession(): TerminalSession {
  if (!globalThis.__soaTerminalSession) {
    globalThis.__soaTerminalSession = new TerminalSession();
  }
  return globalThis.__soaTerminalSession;
}
