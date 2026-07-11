/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <TalkTo tab="data" /> — the SHARED, delightful copilot chat for every Context tab.
 *
 * The design invariant: the model's ANSWER is prominent; the model's REASONING lives in a
 * distinct, muted, collapsible "Thinking" panel — never mixed in. Real citation chips and a
 * collapsible "what ran" (SQL / retrieval) disclosure sit under the answer. One tab id
 * drives it all — the config (examples, title, blurb) comes from the server via the result;
 * the client only needs the tab id + the examples (passed in for the empty state).
 */
import { useCallback, useRef, useState } from 'react';
import Markdown from '@/components/Markdown';

type Citation = { id: string; label: string; href?: string; kind: string };
type Grounding = { kind: 'sql' | 'retrieval' | 'none'; query?: string; evidence?: string; citations: Citation[] };
type TalkResult = {
  ok: boolean;
  answer: string;
  reasoning: string;
  citations: Citation[];
  grounding: Grounding;
  kind?: string;
};

type Turn = {
  question: string;
  result?: TalkResult;
  error?: string;
  pending?: boolean;
};

export type TalkToProps = {
  tab: string;
  /** Panel title, e.g. "Talk to Data". */
  title?: string;
  /** One-line description under the title. */
  blurb?: string;
  /** Example prompts for the empty state (from the tab's TalkConfig). */
  examples?: string[];
};

export default function TalkTo({ tab, title, blurb, examples = [] }: TalkToProps) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const ask = useCallback(
    async (raw?: string) => {
      const q = (raw ?? question).trim();
      if (!q || busy) return;
      setBusy(true);
      setQuestion('');
      // History = the prior answered turns (bounded server-side too).
      const history = turns
        .filter((t) => t.result?.answer)
        .flatMap((t) => [
          { role: 'user' as const, content: t.question },
          { role: 'assistant' as const, content: t.result!.answer },
        ]);
      setTurns((prev) => [...prev, { question: q, pending: true }]);
      try {
        const res = await fetch(`/api/talk/${tab}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q, history }),
        });
        const data = await res.json();
        setTurns((prev) =>
          prev.map((t, i) =>
            i === prev.length - 1
              ? res.ok
                ? { question: q, result: data as TalkResult }
                : { question: q, error: (data?.error as string) ?? `Request failed (${res.status})` }
              : t,
          ),
        );
      } catch (e) {
        setTurns((prev) =>
          prev.map((t, i) => (i === prev.length - 1 ? { question: q, error: (e as Error).message } : t)),
        );
      } finally {
        setBusy(false);
      }
    },
    [question, busy, turns, tab],
  );

  return (
    <div className="talk">
      {title && <div className="section-title">{title}</div>}
      {blurb && (
        <div className="hint" style={{ marginBottom: 14 }}>
          {blurb}
        </div>
      )}

      {/* Conversation */}
      {turns.length > 0 && (
        <div className="talk-thread">
          {turns.map((t, i) => (
            <TurnView key={i} turn={t} />
          ))}
        </div>
      )}

      {/* Empty-state example prompts */}
      {turns.length === 0 && examples.length > 0 && (
        <div className="talk-examples">
          {examples.map((ex) => (
            <button key={ex} type="button" className="talk-example" onClick={() => ask(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="talk-composer">
        <textarea
          ref={taRef}
          rows={2}
          value={question}
          placeholder="Ask in plain language…"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask();
            }
          }}
          spellCheck
        />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          <div className="hint" style={{ marginTop: 0 }}>
            ⌘ / Ctrl + Enter to send.
          </div>
          <button className="btn" onClick={() => ask()} disabled={busy || !question.trim()}>
            {busy ? <span className="spin" /> : 'Ask'}
          </button>
        </div>
      </div>

      <style jsx>{`
        .talk-thread {
          display: flex;
          flex-direction: column;
          gap: 22px;
          margin-bottom: 20px;
        }
        .talk-examples {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 16px;
        }
        .talk-example {
          text-align: left;
          font: inherit;
          font-size: 0.86rem;
          color: var(--text-muted);
          background: var(--tile, var(--panel));
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 7px 14px;
          cursor: pointer;
          transition: border-color 0.15s ease, color 0.15s ease;
        }
        .talk-example:hover {
          border-color: var(--gold-line);
          color: var(--text);
        }
        .talk-composer textarea {
          width: 100%;
          resize: vertical;
          font: inherit;
          background: var(--bg-input, var(--panel));
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 12px 14px;
          line-height: 1.5;
        }
        .talk-composer textarea:focus {
          outline: none;
          border-color: var(--gold-line);
        }
      `}</style>
    </div>
  );
}

// ------------------------------------------------------------------- one turn --

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="turn">
      <div className="turn-q">{turn.question}</div>

      {turn.pending && (
        <div className="turn-pending">
          <span className="spin" /> thinking…
        </div>
      )}

      {turn.error && <div className="error" style={{ marginTop: 8 }}>{turn.error}</div>}

      {turn.result && <ResultView result={turn.result} />}

      <style jsx>{`
        .turn-q {
          font-weight: 600;
          color: var(--text);
          margin-bottom: 10px;
        }
        .turn-pending {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--text-muted);
          font-size: 0.9rem;
        }
      `}</style>
    </div>
  );
}

function ResultView({ result }: { result: TalkResult }) {
  const [showThinking, setShowThinking] = useState(false);
  const [showRan, setShowRan] = useState(false);
  const ran = result.grounding;

  return (
    <div className="result">
      {/* The reasoning — DISTINCT, muted, collapsible. Above the answer, clearly labelled,
          never mixed into it. */}
      {result.reasoning && (
        <div className="thinking">
          <button type="button" className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
            <span className="thinking-dot" />
            {showThinking ? 'Hide thinking' : 'Show thinking'}
          </button>
          {showThinking && (
            <div className="thinking-body">
              <Markdown muted>{result.reasoning}</Markdown>
            </div>
          )}
        </div>
      )}

      {/* The answer — prominent. */}
      <div className="answer">
        <Markdown>{result.answer}</Markdown>
      </div>

      {/* Real citations. */}
      {result.citations.length > 0 && (
        <div className="cites">
          {result.citations.map((c) =>
            c.href ? (
              <a key={c.id} href={c.href} className="cite">
                {c.label}
              </a>
            ) : (
              <span key={c.id} className="cite">
                {c.label}
              </span>
            ),
          )}
        </div>
      )}

      {/* What ran — the governed query / retrieval, collapsible. */}
      {ran.kind !== 'none' && (ran.query || ran.evidence) && (
        <div className="ran">
          <button type="button" className="ran-toggle" onClick={() => setShowRan((v) => !v)}>
            {showRan ? 'Hide' : 'Show'} what ran ({ran.kind === 'sql' ? 'SQL' : 'retrieval'})
          </button>
          {showRan && (
            <div className="ran-body">
              {ran.query && <pre className="mono ran-pre">{ran.query}</pre>}
              {ran.evidence && <pre className="mono ran-pre ran-evidence">{ran.evidence}</pre>}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .thinking {
          margin-bottom: 12px;
        }
        .thinking-toggle {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font: inherit;
          font-size: 0.8rem;
          color: var(--text-muted);
          background: transparent;
          border: none;
          padding: 0;
          cursor: pointer;
        }
        .thinking-toggle:hover {
          color: var(--text);
        }
        .thinking-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: var(--text-faint, var(--text-muted));
        }
        .thinking-body {
          margin-top: 8px;
          padding: 12px 14px;
          border-left: 2px solid var(--border);
          background: var(--tile, var(--panel));
          border-radius: 6px;
        }
        .answer {
          color: var(--text);
          font-size: 1rem;
          line-height: 1.65;
        }
        .cites {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 12px;
        }
        .cite {
          font-size: 12px;
          background: var(--gold-soft);
          border: 1px solid var(--gold-line);
          color: var(--gold-text);
          border-radius: 999px;
          padding: 4px 11px;
          text-decoration: none;
        }
        a.cite:hover {
          border-color: var(--gold-text);
        }
        .ran {
          margin-top: 12px;
        }
        .ran-toggle {
          font: inherit;
          font-size: 0.78rem;
          color: var(--text-faint, var(--text-muted));
          background: transparent;
          border: none;
          padding: 0;
          cursor: pointer;
        }
        .ran-toggle:hover {
          color: var(--text);
        }
        .ran-pre {
          margin-top: 8px;
          font-size: 0.78rem;
          background: var(--bg-elevated, var(--panel));
          padding: 10px 12px;
          border-radius: 6px;
          overflow-x: auto;
          white-space: pre-wrap;
        }
        .ran-evidence {
          color: var(--text-muted);
        }
      `}</style>
    </div>
  );
}
