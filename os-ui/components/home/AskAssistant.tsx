/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';

/**
 * Home "ask anything" box → the governed domain assistant (POST /api/home/ask).
 * Two-mode: it answers, or scaffolds a Personal draft (owned by the asker) and
 * deep-links into the owning tab to finish. Promote/certify stay human, surfaced
 * as a calm "human-gate" note rather than an action. Langfuse-traced server-side.
 */

type AskResult = {
  mode: 'answer' | 'scaffold' | 'human-gate';
  text: string;
  deepLink?: string;
  draft?: { id: string; name: string; type: string };
  traceId: string;
};

const SUGGESTIONS = [
  'Build a dashboard of churn by region',
  'Create an agent that drafts renewal emails',
  'Define a metric for net revenue retention',
];

export default function AskAssistant() {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/home/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: q }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'The assistant could not respond.');
      setResult(body.result as AskResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ask-box">
      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(prompt);
        }}
      >
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask anything, or “build a dashboard of …”"
          aria-label="Ask the domain assistant"
        />
        <button className="btn" type="submit" disabled={busy || !prompt.trim()}>
          {busy ? <span className="spin" /> : 'Ask'}
        </button>
      </form>

      {!result && !error ? (
        <div className="ask-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="ask-chip" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className={`ask-answer ask-${result.mode}`}>
          <div className="ask-answer-tag">
            {result.mode === 'scaffold' ? 'Scaffolded a draft' : result.mode === 'human-gate' ? 'Stays a human decision' : 'Answer'}
          </div>
          <p>{result.text}</p>
          {result.deepLink ? (
            <Link className="btn ghost sm" href={result.deepLink}>
              {result.mode === 'scaffold' ? 'Open & finish →' : 'Go to the governed flow →'}
            </Link>
          ) : null}
          <div className="ask-trace">traced · {result.traceId}</div>
        </div>
      ) : null}
    </div>
  );
}
