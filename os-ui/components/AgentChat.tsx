/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useRef, useState } from 'react';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Reusable task-scoped agent chat window. The same component backs every
 * "agent" surface in the OS (agent builder, software builder, per-data-product
 * dbt assistant, knowledge agent, connections agent): it POSTs the running
 * conversation to /api/agent-chat with an `agent` key, and the server maps that
 * key to a governed system prompt and forwards to the LiteLLM gateway. No
 * backend address or key ever reaches the browser.
 */
export default function AgentChat({
  agent,
  placeholder = 'Describe what you want to build…',
  starters = [],
  onAssistant,
  minHeight = 240,
  label = 'agent',
}: {
  agent: string;
  placeholder?: string;
  starters?: string[];
  onAssistant?: (content: string) => void;
  minHeight?: number;
  label?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || loading) return;
      setError('');
      const next: ChatMessage[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setLoading(true);
      try {
        const res = await fetch('/api/agent-chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent, messages: next }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Request failed');
        } else {
          const reply = String(data.content ?? '');
          setMessages((m) => [...m, { role: 'assistant', content: reply }]);
          onAssistant?.(reply);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        });
      }
    },
    [agent, loading, messages, onAssistant],
  );

  return (
    <div className="chat">
      <div className="chat-log" style={{ minHeight }} ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            Start a conversation with the {label}. It runs through the governed
            LiteLLM gateway and is traced in Langfuse.
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
            <div className="bubble-body">
              <span className="spin" />
            </div>
          </div>
        ) : null}
      </div>

      {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}

      {starters.length > 0 && messages.length === 0 ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {starters.map((s) => (
            <button
              key={s}
              type="button"
              className="chip"
              style={{ cursor: 'pointer', background: 'transparent' }}
              onClick={() => send(s)}
            >
              {s.length > 52 ? `${s.slice(0, 52)}…` : s}
            </button>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        style={{ marginTop: 12 }}
      >
        <textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to send.</div>
          <button className="btn" type="submit" disabled={loading || !input.trim()}>
            {loading ? <span className="spin" /> : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
