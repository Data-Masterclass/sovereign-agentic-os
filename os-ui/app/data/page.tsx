/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import DataTab from '@/components/data/DataTab';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

// The Data tab is ONE screen, in one scroll: the datasets home on top (the unified,
// Files-style grid — All · My · Shared · Marketplace, with catalog detail folded into
// each dataset), and the Talk-to-Data NL panel at the bottom.
// Raw SQL lives in Admin → Query (admin-only); conversational Q&A here is governed NL→SQL.

type AskResult =
  | {
      ok: true;
      sql: string;
      columns: string[];
      rows: string[][];
      rowCount: number;
      answer: string;
    }
  | {
      ok: false;
      kind: string;
      error: string;
      sql?: string | null;
    };

export default function DataPage() {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setResult(null);
    try {
      const res = await fetch('/api/data/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      setResult(data as AskResult);
    } catch (e) {
      setResult({ ok: false, kind: 'network_error', error: (e as Error).message });
    } finally {
      setAsking(false);
    }
  }, [question, asking]);

  return (
    <>
      <PageHeader title="Data" crumb="datasets · ask" tutorial="data" />
      <div className="content">
        {/* Top: the datasets home (tiles → detail → build flow). */}
        <div {...anchorAttr(ANCHORS.data.sandbox)}>
          <DataTab />
        </div>

        {/* Bottom: Talk to Data — governed NL→SQL, same OPA/Trino path as the assistant. */}
        <div className="query-section" style={{ marginTop: 40 }} {...anchorAttr(ANCHORS.data.query)}>
          <div className="section-title">Talk to Data</div>
          <div className="hint" style={{ marginBottom: 12 }}>
            Ask a question in plain language. The OS turns it into a governed read-only
            query, runs it against the datasets you can see, and answers from the rows —
            nothing invented.
          </div>

          <textarea
            ref={textareaRef}
            className="mono"
            rows={3}
            value={question}
            placeholder="e.g. What was total revenue last month by product?"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                ask();
              }
            }}
            spellCheck
          />

          <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="hint" style={{ marginTop: 0 }}>⌘ / Ctrl + Enter to ask.</div>
            <button
              className="btn"
              onClick={ask}
              disabled={asking || !question.trim()}
            >
              {asking ? <span className="spin" /> : 'Ask'}
            </button>
          </div>

          {/* Answer */}
          {result && (
            <div style={{ marginTop: 24 }}>
              {result.ok ? (
                <>
                  {result.answer && (
                    <div className="section-title" style={{ fontFamily: 'inherit', fontWeight: 400, fontSize: '0.95rem', marginBottom: 12 }}>
                      {result.answer}
                    </div>
                  )}

                  {result.rowCount > 0 && result.columns.length > 0 ? (
                    <div className="table-wrap" style={{ marginBottom: 16 }}>
                      <table>
                        <thead>
                          <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                        </thead>
                        <tbody>
                          {result.rows.map((r, i) => (
                            <tr key={i}>
                              {r.map((cell, j) => <td key={j}>{cell ?? <span className="muted">—</span>}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="hint" style={{ marginTop: 4 }}>
                        {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                      </div>
                    </div>
                  ) : result.rowCount === 0 ? null : null}

                  {/* SQL transparency — always show the governed query that ran */}
                  {result.sql && (
                    <details style={{ marginTop: 8 }}>
                      <summary className="hint" style={{ cursor: 'pointer', userSelect: 'none' }}>
                        SQL that ran
                      </summary>
                      <pre className="mono" style={{ marginTop: 8, fontSize: '0.8rem', background: 'var(--surface, #f7f7f7)', padding: '10px 12px', borderRadius: 6, overflowX: 'auto' }}>
                        {result.sql}
                      </pre>
                    </details>
                  )}
                </>
              ) : (
                <div className="error">
                  {result.error}
                  {result.sql && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer' }}>SQL attempted</summary>
                      <pre className="mono" style={{ marginTop: 6, fontSize: '0.8rem' }}>{result.sql}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
