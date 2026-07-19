/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import { parseAgentChatResponse, stripThinking } from '@/lib/agents/agent-chat-response';
import BuildDiff, { type FileChange } from './BuildDiff';
import { summarizeChanges } from '@/lib/software/build-changeset';

export type { FileChange };
export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type BuildMode = 'plan' | 'build';
export type BuildStory = { epicId: string; storyId: string; label?: string };

/**
 * The Software BUILD-stage chat — a Build-lane-owned variant of AgentChat that
 * (1) sends the current {mode, story} to the per-app chat route, and (2) surfaces
 * the per-run before/after CHANGESET the route returns as inline diffs. Plan mode
 * runs the assistant read-only (the route enforces the read-only tool allowlist);
 * Build mode executes end-to-end and reports its file changes. Kept separate from
 * the shared AgentChat so the shared component stays generic.
 */
export default function BuildChat({
  appId,
  appName,
  mode,
  story,
  initialMessages = [],
  onBuilt,
}: {
  appId: string;
  appName: string;
  mode: BuildMode;
  story: BuildStory | null;
  initialMessages?: ChatMessage[];
  /** Called after a BUILD run that changed files, so the parent can mark the story done + reload. */
  onBuilt?: (changes: FileChange[]) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialMessages.map((m) => (m.role === 'assistant' ? { ...m, content: stripThinking(m.content) } : m)),
  );
  const [lastChanges, setLastChanges] = useState<FileChange[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || loading) return;
      setError('');
      setStopped(false);
      const next: ChatMessage[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setLoading(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`/api/apps/${appId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: 'software', messages: next, mode, story: story ?? undefined }),
          signal: ctrl.signal,
        });
        const raw = await res.text();
        // Pull the structured changeset out before the defensive text parse (which
        // only knows about {content}). A malformed body just yields no changes.
        let changes: FileChange[] = [];
        try {
          const j = JSON.parse(raw);
          if (Array.isArray(j?.changes)) changes = j.changes as FileChange[];
        } catch {
          /* handled by parseAgentChatResponse below */
        }
        const parsed = parseAgentChatResponse(res.ok, res.status, raw);
        if ('error' in parsed) {
          setError(parsed.error);
        } else {
          setMessages((m) => [...m, { role: 'assistant', content: parsed.content }]);
          setLastChanges(changes);
          if (mode === 'build' && changes.length > 0) onBuilt?.(changes);
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') setStopped(true);
        else setError((e as Error).message);
      } finally {
        abortRef.current = null;
        setLoading(false);
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      }
    },
    [appId, loading, messages, mode, story, onBuilt],
  );

  const planning = mode === 'plan';
  const label = planning ? 'plan assistant' : 'build assistant';

  return (
    <div className="chat claude">
      <div className="chat-log" style={{ minHeight: 360 }} ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            {planning
              ? 'Plan mode — the assistant discusses and drafts an implementation plan. It makes no code changes.'
              : `Describe what to build or change in ${appName}. Build mode commits real code and shows you the diff.`}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="bubble-role">{m.role === 'user' ? 'You' : label}</div>
              <div className="bubble-body">{m.content}</div>
            </div>
          ))
        )}
        {loading ? (
          <div className="bubble assistant">
            <div className="bubble-role">{label}</div>
            <div className="bubble-body row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="spin" />
              <span className="muted" style={{ fontSize: 12 }}>
                {planning ? 'Planning…' : 'Building…'} the model can take a moment on the first message.
              </span>
              <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={stop}>Stop</button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
      {stopped ? <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Stopped.</div> : null}

      {/* The per-run changeset — before/after diffs of what this Build run committed. */}
      {!planning && lastChanges.length > 0 ? (
        <BuildDiff changes={lastChanges} summary={summarizeChanges(lastChanges)} />
      ) : null}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} style={{ marginTop: 12 }}>
        <textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={planning ? 'Ask the assistant to plan a change (no code is written)…' : `Describe what to build or change in ${appName}…`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(input); }
          }}
        />
        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send.</div>
          {loading ? (
            <button className="btn ghost" type="button" onClick={stop}>Stop</button>
          ) : (
            <button className="btn" type="submit" disabled={!input.trim()}>{planning ? 'Plan' : 'Build'}</button>
          )}
        </div>
      </form>
    </div>
  );
}
