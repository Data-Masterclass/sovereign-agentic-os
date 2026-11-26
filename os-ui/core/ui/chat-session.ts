/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Ask the OS chat session — one conversation that keeps running while the user moves between tabs
 * USER STORY: As a user I want a question I asked on Home to keep working when I open another tab, show
 *             me that it is working on the "Ask the OS" button, and show me the full answer when I come
 *             back or open the panel — the same conversation on Home and in the panel.
 * ARCHITECTURE:
 *   - A plain module-level store, outside any React component's lifetime. React surfaces read it with
 *     `useSyncExternalStore` (`core/ui/useChatSession.ts`); `core/ui/OsAssistant.tsx` (the global panel,
 *     mounted in `app/layout.tsx`) and `tabs/home/ui/HomeChat.tsx` both render from the ONE instance
 *     `chatSession`, so a client navigation unmounts a view but never the turn.
 *   - It owns the conversation (id, messages), the live turn (steps, streamed draft, status, busy, error),
 *     the AbortController and the ONE reader of `/api/assistant/chat`'s NDJSON stream (`token`, `status`,
 *     `step`, `done`, `error`). A non-stream answer (an error body, a proxy page) goes through
 *     `parseAgentChatResponse`, so it is always a readable sentence.
 *   - A turn is stopped only by `stop()` (the Stop button), `reset()` (New chat), `loadConversation()`
 *     (switching to another conversation) or `signOut()`. Unmounting a view, closing the panel or a route
 *     change never aborts it.
 *   - Page context is read AT SEND TIME from a provider the global panel registers
 *     (`setContextProvider`): each new user message carries the path and published page context of the
 *     page the user is on when they press Send, not the page where the conversation began.
 *   - `ready` is the "answer ready" dot: set when a turn finishes (answer or error) while no view is
 *     attached (`attachView`), cleared when a view attaches.
 *   - In-memory only: a full reload or a new browser tab starts empty (follow-up: resume from the
 *     persisted conversation, `/api/assistant/conversations/<id>`).
 *   - `'use client'`: it is browser code (it calls the OS's own same-origin API, never a component).
 *   - I18N: an error this module writes itself is a `ViewText` key (`session.errors.*`, `confirm.notes.gone`),
 *     translated where it renders; an error the server sent is shown as the server wrote it (a string).
 */
'use client';

import { parseStreamLines, streamStatusText, viewText, type Shown, type StreamEvent, type TypedError, type ViewText } from '@core/ui/chat-view';
import { parseArtifacts, type ChatArtifact } from '@core/runtime/chat-artifacts';
import { parseAgentChatResponse } from '@core/runtime/chat-response';
import type { Pending } from '@core/ui/ConfirmCard';

export type ChatStep = { name: string; isError: boolean; parked?: boolean; error?: TypedError };
export type SaveAsKind = 'kpi' | 'dashboard' | 'knowledge' | 'agent';
/** English names for non-UI readers; the chat renders `session.saveAs.<kind>` in the user's language. */
export const SAVE_LABELS: Record<SaveAsKind, string> = { kpi: 'KPI', dashboard: 'Dashboard', knowledge: 'Knowledge note', agent: 'Agent' };
export type SessionErrorKey = 'session.errors.incomplete' | 'session.errors.cutOff' | 'session.errors.conversationGone';

/** An error this module raises itself: carries the catalog key, so the view shows it in the user's language. */
class SessionError extends Error {
  readonly view: ViewText<SessionErrorKey>;
  constructor(view: ViewText<SessionErrorKey>) {
    super(view.key);
    this.view = view;
  }
}
export type ModelTraceView = {
  calls: { purpose: string; role: string; model: string; escalated: boolean }[];
  byRole: Record<string, { calls: number; cost?: number }>;
};
export type ChatMsg = {
  role: 'user' | 'assistant';
  content: string;
  saveAs?: SaveAsKind[];
  steps?: ChatStep[];
  pending?: Pending[];
  artifacts?: ChatArtifact[];
  /** Which role and model handled each step of the turn, and the cost per role. */
  trace?: ModelTraceView;
  failed?: boolean;
};

export type ChatSnapshot = {
  readonly conversationId: string;
  readonly messages: readonly ChatMsg[];
  /** Steps of the running turn, in the order they finished. */
  readonly live: readonly ChatStep[];
  /** Streamed answer text of the running turn. */
  readonly draft: string;
  /** A quiet server status while the turn runs (e.g. the model is busy and it retries). */
  readonly status: string;
  readonly busy: boolean;
  /** '' when none; server text as written, or a `session.errors.*` key. */
  readonly error: Shown;
  /** A turn finished while no view was looking at it. */
  readonly ready: boolean;
};

/** Where the user is when they press Send. */
export type ChatContext = { path: string; pageContext?: unknown };

export type ChatSessionDeps = {
  fetch?: typeof fetch;
  newId?: () => string;
};

export type SendOptions = { prior?: readonly ChatMsg[]; saveAs?: SaveAsKind };

export type ChatSession = {
  getSnapshot(): ChatSnapshot;
  subscribe(listener: () => void): () => void;
  send(text: string, opts?: SendOptions): Promise<void>;
  /** False while a turn runs: `send` would drop the message, so a view must keep its input. */
  canSend(): boolean;
  /** Re-send the failed user message at `index`, dropping it and everything after it. */
  retry(index: number): Promise<void>;
  stop(): void;
  /** New conversation: stops a running turn and starts empty. */
  reset(): void;
  /** Open a stored conversation; the latest call wins, and a running turn stops once it loaded.
   *  False when it is gone, unreachable, or superseded. */
  loadConversation(id: string): Promise<boolean>;
  deleteConversation(id: string): Promise<void>;
  /** Update one confirm card (Run / Decline on a pending write). Addressed by conversation and
   *  confirmation id, never by position: a decision that returns after the user switched or started
   *  a new conversation changes nothing. */
  patchPending(conversationId: string, confirmationId: string, patch: Partial<Pending>): void;
  setError(message: Shown): void;
  setContextProvider(provider: () => ChatContext): () => void;
  /** A view (Home chat, the open panel) is showing the conversation. Returns the detach function. */
  attachView(): () => void;
  /** Sign-out: stop and forget everything. */
  signOut(): void;
};

export const newConversationId = (): string =>
  `c-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;

const defaultContext = (): ChatContext => ({
  path: typeof window === 'undefined' ? '/' : window.location.pathname || '/',
  pageContext: null,
});

/** The empty conversation; also what the server renders (no turn ever runs on the server). */
export function emptySnapshot(conversationId = ''): ChatSnapshot {
  return { conversationId, messages: [], live: [], draft: '', status: '', busy: false, error: '', ready: false };
}

/** The stored turn as a message; the `done` event and the JSON response carry the same payload. */
function assistantMessage(done: Record<string, unknown>, content: string): ChatMsg {
  const artifacts = parseArtifacts(done);
  const steps = Array.isArray(done.tools) ? (done.tools as ChatStep[]) : [];
  const pending = Array.isArray(done.pending) ? (done.pending as Pending[]).map((p) => ({ ...p, state: 'open' as const })) : [];
  return {
    role: 'assistant',
    content,
    steps,
    pending,
    artifacts: artifacts.length ? artifacts : undefined,
    saveAs: Array.isArray(done.saveAs) ? (done.saveAs as SaveAsKind[]) : [],
    trace: done.modelTrace as ModelTraceView | undefined,
  };
}

export function createChatSession(deps: ChatSessionDeps = {}): ChatSession {
  const doFetch = (...a: Parameters<typeof fetch>) => (deps.fetch ?? globalThis.fetch)(...a);
  const newId = deps.newId ?? newConversationId;
  let snap: ChatSnapshot = emptySnapshot(newId());
  const listeners = new Set<() => void>();
  let ctrl: AbortController | null = null;
  /** Bumped by every send/stop-and-switch, so a superseded turn's late events change nothing. */
  let turn = 0;
  let views = 0;
  let contextProvider: () => ChatContext = defaultContext;
  /** Bumped by every load and every switch, so only the latest History click lands. */
  let load = 0;

  const set = (patch: Partial<ChatSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const l of [...listeners]) l();
  };
  const abortTurn = () => {
    turn += 1;
    load += 1;
    ctrl?.abort();
    ctrl = null;
  };

  async function send(text: string, opts: SendOptions = {}): Promise<void> {
    const content = text.trim();
    if (!content || snap.busy) return;
    const ctx = contextProvider(); // the page the user is on NOW
    const prior = opts.prior ?? snap.messages;
    const next: ChatMsg[] = [...prior, { role: 'user', content }];
    const conversationId = snap.conversationId;
    const mine = ++turn;
    load += 1; // a History load still in flight gives way to the message the user just sent
    const c = new AbortController();
    ctrl = c;
    set({ messages: next, live: [], draft: '', status: '', error: '', busy: true, ready: false });
    const alive = () => mine === turn;
    let outcome: 'answer' | 'error' | 'aborted' = 'aborted';
    try {
      const res = await doFetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: ctx.path || '/',
          conversationId,
          stream: true,
          ...(opts.saveAs ? { saveAs: opts.saveAs } : {}),
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          pageContext: ctx.pageContext ?? null,
        }),
        signal: c.signal,
      });
      let done: Record<string, unknown> | null = null;
      let raw: string;
      if (!res.ok || !res.body || !/ndjson/.test(res.headers.get('content-type') ?? '')) {
        // Not a live stream: an error body, a proxy page, or a plain JSON answer.
        raw = await res.text();
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let rest = '';
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end || !alive()) break;
          const parsed = parseStreamLines(rest, dec.decode(value, { stream: true }));
          rest = parsed.rest;
          for (const ev of parsed.events as StreamEvent[]) {
            if (ev.type === 'token') set({ status: '', draft: snap.draft + String(ev.t ?? '') });
            else if (ev.type === 'status') set({ status: streamStatusText(ev) ?? '' });
            else if (ev.type === 'step') set({ status: '', draft: '', live: [...snap.live, ev as unknown as ChatStep] });
            else if (ev.type === 'done') done = ev;
            else if (ev.type === 'error') throw ev.error == null ? new SessionError(viewText('session.errors.incomplete')) : new Error(String(ev.error));
          }
        }
        if (!alive()) return;
        if (!done) throw new SessionError(viewText('session.errors.cutOff'));
        raw = JSON.stringify(done);
      }
      if (!alive()) return;
      // One validation for both paths: a reply without string content is a readable error, not an empty bubble.
      const parsed = parseAgentChatResponse(res.ok, res.status, raw);
      if ('error' in parsed) throw new Error(parsed.error);
      done ??= JSON.parse(raw) as Record<string, unknown>;
      set({ messages: [...snap.messages, assistantMessage(done, parsed.content)] });
      outcome = 'answer';
    } catch (e) {
      if (!alive() || (e as Error).name === 'AbortError') return;
      outcome = 'error';
      const msgs = snap.messages;
      set({
        error: e instanceof SessionError ? e.view : (e as Error).message,
        messages: msgs.map((x, i) => (i === msgs.length - 1 && x.role === 'user' ? { ...x, failed: true } : x)),
      });
    } finally {
      if (alive()) {
        ctrl = null;
        set({ live: [], draft: '', status: '', busy: false, ready: outcome !== 'aborted' && views === 0 });
      }
    }
  }

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    send,
    canSend: () => !snap.busy,
    retry(index) {
      const m = snap.messages[index];
      if (!m || m.role !== 'user') return Promise.resolve();
      return send(m.content, { prior: snap.messages.slice(0, index) });
    },
    stop() {
      if (!snap.busy) return;
      abortTurn();
      set({ live: [], draft: '', status: '', busy: false });
    },
    reset() {
      abortTurn();
      set({ ...emptySnapshot(newId()) });
    },
    async loadConversation(id) {
      const mine = ++load;
      type Stored = { id: string; messages: { role: 'user' | 'assistant'; content: string; steps?: ChatStep[]; pending?: { confirmationId: string; tool: string }[] }[] };
      let c: Stored | null = null;
      try {
        const r = await doFetch(`/api/assistant/conversations/${encodeURIComponent(id)}`);
        if (r.ok) c = (await r.json()) as Stored;
      } catch { /* unreachable: reported below like a missing conversation */ }
      if (mine !== load) return false; // a later click, New chat or sign-out won
      if (!c || !Array.isArray(c.messages)) { set({ error: viewText('session.errors.conversationGone') }); return false; }
      abortTurn();
      set({
        ...emptySnapshot(c.id),
        messages: c.messages.map((m) => ({
          role: m.role,
          content: m.content,
          steps: m.steps,
          // A pending write's arguments are never stored: after a reload its card is closed.
          pending: m.pending?.map((p) => ({ ...p, args: {}, expiresAt: '', state: 'gone' as const, note: viewText('confirm.notes.gone') })),
        })),
      });
      return true;
    },
    async deleteConversation(id) {
      await doFetch('/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleteConversation: id }) });
      if (id === snap.conversationId) { abortTurn(); set({ ...emptySnapshot(newId()) }); }
    },
    patchPending(conversationId, confirmationId, patch) {
      if (conversationId !== snap.conversationId) return; // the user moved on; the decision is stored server-side
      if (!snap.messages.some((m) => m.pending?.some((x) => x.confirmationId === confirmationId))) return;
      set({
        messages: snap.messages.map((m) => (!m.pending?.some((x) => x.confirmationId === confirmationId) ? m : {
          ...m,
          pending: m.pending.map((x) => (x.confirmationId === confirmationId ? { ...x, ...patch } : x)),
        })),
      });
    },
    setError(message) { set({ error: message }); },
    setContextProvider(provider) {
      contextProvider = provider;
      return () => { if (contextProvider === provider) contextProvider = defaultContext; };
    },
    attachView() {
      views += 1;
      if (snap.ready) set({ ready: false });
      let attached = true;
      return () => { if (attached) { attached = false; views -= 1; } };
    },
    signOut() {
      abortTurn();
      set({ ...emptySnapshot(newId()) });
    },
  };
}

/** The browser's one session. Never driven on the server: views read `emptySnapshot()` there. */
export const chatSession: ChatSession = createChatSession();
