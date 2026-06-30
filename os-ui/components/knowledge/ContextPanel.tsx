/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * Context panel — shows how an agent gets context for a task over this workflow.
 * Ask a question; the governed retriever returns a token-budgeted context pack:
 * what is PINNED (always present — domain card, workflow steps, hard rules) vs what
 * was RETRIEVED (reranked top-k tail), with citations and the governance decision.
 * The indexing / embeddings / OPA / DLS machinery stays hidden — the surface shows
 * "what the agent will see, and why".
 */

type PackItem = {
  source: 'pinned' | 'retrieved';
  kind: 'hard-rule' | 'domain' | 'workflow-step' | 'evidence';
  id: string;
  title: string;
  text: string;
  tokens: number;
  cite: string;
};
type RetrieveResponse = {
  decision: 'allow' | 'deny';
  policy: string;
  reason: string;
  store: string;
  mode: 'hybrid' | 'bm25' | 'offline';
  embedSource: string;
  pack: { items: PackItem[]; pinnedTokens: number; retrievedTokens: number; totalTokens: number; budget: number; dropped: number };
  citations: { id: string; title: string; type: string; score: number; trust: number }[];
  trace: { id: string; landed: boolean };
};

const KIND_LABEL: Record<string, string> = {
  'hard-rule': 'Hard rule',
  domain: 'Domain',
  'workflow-step': 'Step',
  evidence: 'Evidence',
};

export default function ContextPanel({ workflowId }: { workflowId: string }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<RetrieveResponse | null>(null);
  const [error, setError] = useState('');

  async function run(q: string) {
    const text = q.trim();
    if (!text || loading) return;
    setLoading(true);
    setError('');
    setRes(null);
    try {
      const r = await fetch(`/api/knowledge/workflows/${workflowId}/retrieve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text }),
      });
      const data = await r.json();
      if (!r.ok) setError(data.error ?? 'Retrieval failed');
      else setRes(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const pinned = res?.pack.items.filter((i) => i.source === 'pinned') ?? [];
  const retrieved = res?.pack.items.filter((i) => i.source === 'retrieved') ?? [];

  return (
    <div className="ctx-panel">
      <p className="hint" style={{ marginTop: 0 }}>
        What an agent sees when it works on this workflow. Pin a small operating manual; retrieve the
        rest on demand. Ask a question to assemble the context pack.
      </p>

      <form onSubmit={(e) => { e.preventDefault(); void run(query); }} className="row" style={{ gap: 10 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. What can go wrong submitting to the bank portal?"
          style={{ flex: 1 }}
        />
        <button className="btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? <span className="spin" /> : 'Assemble context'}
        </button>
      </form>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {['income verification date', 'error rate threshold', 'friday submission deadline'].map((ex) => (
          <button key={ex} type="button" className="chip" style={{ cursor: 'pointer', background: 'transparent' }}
            onClick={() => { setQuery(ex); void run(ex); }}>{ex}</button>
        ))}
      </div>

      {error && <div className="error" style={{ marginTop: 14 }}>{error}</div>}

      {res && (
        <>
          {/* Governance + assembly summary */}
          <div className="ctx-summary" style={{ marginTop: 16 }}>
            <span className={`badge ${res.decision === 'allow' ? 'ok' : 'err'}`}>
              {res.decision === 'allow' ? '✓ retrieval allowed' : '✗ retrieval denied'}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>policy {res.policy}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              store: {res.store === 'opensearch' ? 'OpenSearch' : 'offline mock'}
              {res.mode === 'hybrid' ? ' · hybrid knn+BM25' : res.mode === 'bm25' ? ' · BM25' : ' · dense+lexical'}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>embed: {res.embedSource === 'litellm' ? 'sovereign-embed' : 'offline hash'}</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {res.pack.totalTokens}/{res.pack.budget} tokens
              {res.pack.dropped > 0 ? ` · ${res.pack.dropped} dropped` : ''}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>trace {res.trace.landed ? 'logged' : 'buffered'}</span>
          </div>

          {/* Two columns: pinned vs retrieved */}
          <div className="ctx-cols">
            <div className="ctx-col">
              <div className="ctx-col-head">
                <span className="ctx-col-title">Pinned</span>
                <span className="muted" style={{ fontSize: 11 }}>{res.pack.pinnedTokens} tok · always present</span>
              </div>
              {pinned.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>—</div> : pinned.map((it) => (
                <div key={it.id} className={`ctx-item pinned ${it.kind}`}>
                  <div className="ctx-item-head">
                    <span className={`badge ${it.kind === 'hard-rule' ? 'warn' : 'muted'}`} style={{ fontSize: 10 }}>
                      {KIND_LABEL[it.kind]}
                    </span>
                    <span className="ctx-item-title">{it.title}</span>
                  </div>
                  <div className="ctx-item-text">{it.text}</div>
                </div>
              ))}
            </div>

            <div className="ctx-col">
              <div className="ctx-col-head">
                <span className="ctx-col-title">Retrieved</span>
                <span className="muted" style={{ fontSize: 11 }}>{res.pack.retrievedTokens} tok · reranked top-k</span>
              </div>
              {retrieved.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>No retrieved evidence for this query.</div> : retrieved.map((it, i) => {
                const cit = res.citations.find((c) => c.id === it.id);
                return (
                  <div key={it.id} className="ctx-item retrieved">
                    <div className="ctx-item-head">
                      <span className="badge muted" style={{ fontSize: 10 }}>#{i + 1}</span>
                      <span className="ctx-item-title">{it.title}</span>
                      {cit && <span className="muted" style={{ fontSize: 10, marginLeft: 'auto' }}>score {cit.score} · trust {cit.trust}</span>}
                    </div>
                    <div className="ctx-item-text">{it.text}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <style>{ContextStyles}</style>
    </div>
  );
}

const ContextStyles = `
.ctx-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ctx-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
@media (max-width: 760px) { .ctx-cols { grid-template-columns: 1fr; } }
.ctx-col { display: flex; flex-direction: column; gap: 9px; }
.ctx-col-head { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.ctx-col-title { font-family: var(--font-head); font-size: 12px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: var(--gold-text); }
.ctx-item { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--panel); }
.ctx-item.pinned.hard-rule { border-color: var(--gold-line); background: var(--gold-soft); }
.ctx-item-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.ctx-item-title { font-size: 12.5px; font-weight: 600; }
.ctx-item-text { font-size: 12px; color: var(--text-muted); white-space: pre-wrap; line-height: 1.5; }
`;
