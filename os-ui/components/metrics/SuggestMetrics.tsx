/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { type DatasetGroups, datasetLayerLabel } from './shared';

/**
 * The strategy-grounded "Suggest metrics" panel — the calm entry point at Define. It
 * works with NO dataset chosen: the server assembles the caller's pillars, operating
 * model, processes and visible datasets, and returns 3–6 grounded candidates. One click
 * on a card pre-fills the dataset + full form and lands the builder on Refine.
 *
 * Honest by construction: the grounding banner names what actually informed the ask (and
 * links to Strategy / Operating Model when they're empty), and an offline assistant shows
 * the route's own 503/402 message — never a fabricated suggestion.
 */

/** Mirrors lib/metrics/suggest.ts — the client only needs to READ these (types, not logic). */
type MetricFormLite = { name: string; aggregation: string; column: string; dimensions: string[] };
type CrossEntity = { note: string; datasets: string[] };
export type Candidate = {
  name: string;
  description: string;
  why: string;
  pillarId?: string;
  processId?: string;
  datasetId: string;
  form: MetricFormLite;
  crossEntity?: CrossEntity;
};
type Grounding = { pillars: number; omSections: number; workflows: number; datasets: number };
type SuggestResult = { candidates: Candidate[]; grounding: Grounding };

/** A one-line human summary of the measure shape (no jargon). */
function shapeSummary(form: MetricFormLite): string {
  const agg =
    form.aggregation === 'count' ? 'Count of rows'
    : form.aggregation === 'count_distinct' || form.aggregation === 'count_distinct_approx' ? `Unique ${form.column || 'values'}`
    : form.aggregation === 'number' ? 'Ratio'
    : `${form.aggregation[0].toUpperCase()}${form.aggregation.slice(1)} of ${form.column || '—'}`;
  const by = form.dimensions.length ? ` by ${form.dimensions.join(', ')}` : '';
  return `${agg}${by}`;
}

export default function SuggestPanel({
  goal,
  onGoal,
  onPick,
}: {
  goal: string;
  onGoal: (g: string) => void;
  onPick: (c: Candidate) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [dsMeta, setDsMeta] = useState<Record<string, { name: string; tier: string }>>({});

  // A tiny id→{name,tier} map so a candidate's dataset chip shows a name + layer badge
  // (the same governed list the picker reads; failure just degrades to the raw id).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/data/datasets', { cache: 'no-store' });
        if (!res.ok) return;
        const g = (await res.json()) as DatasetGroups;
        const map: Record<string, { name: string; tier: string }> = {};
        for (const d of [...g.mine, ...g.domain, ...g.marketplace]) map[d.id] = { name: d.name, tier: d.tier };
        setDsMeta(map);
      } catch { /* chips degrade to the id */ }
    })();
  }, []);

  const ask = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const res = await fetch('/api/metrics/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'suggest', goal: goal.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.error as string | undefined) ?? `Request failed (${res.status})`);
      setResult({
        candidates: Array.isArray(data.candidates) ? (data.candidates as Candidate[]) : [],
        grounding: (data.grounding as Grounding) ?? { pillars: 0, omSections: 0, workflows: 0, datasets: 0 },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const g = result?.grounding;
  const strategyThin = !!g && g.pillars === 0 && g.omSections === 0 && g.workflows === 0;

  return (
    <div className="guided-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <span className="comp-label" style={{ margin: 0 }}>Suggest metrics</span>
          <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
            Let the assistant propose metrics from your strategy and data — no dataset needed.
          </p>
        </div>
        <button className="btn" onClick={ask} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
          {busy ? <span className="spin" /> : 'Suggest metrics'}
        </button>
      </div>

      <input
        placeholder="Optional: steer it — e.g. metrics for our checkout funnel"
        value={goal}
        onChange={(e) => onGoal(e.target.value)}
        style={{ marginTop: 10, width: '100%', maxWidth: 520 }}
      />

      {error ? (
        <div className="stub-page" style={{ marginTop: 12 }}>
          The assistant is unavailable right now — {error}
        </div>
      ) : null}

      {result ? (
        result.candidates.length === 0 ? (
          <div className="stub-page" style={{ marginTop: 12 }}>
            {g && g.datasets === 0
              ? 'No datasets are visible to you yet — build or get access to a governed Gold dataset in Data, then try again.'
              : 'No grounded suggestions this time. Add a goal above, or refine your Strategy and Operating Model, and try again.'}
          </div>
        ) : (
          <>
            {strategyThin ? (
              <p className="hint" style={{ marginTop: 12 }}>
                These are grounded in your data only. Define <a href="/strategy">Strategic Pillars</a> and
                your <a href="/knowledge">Operating Model</a> to get strategy-grounded suggestions.
              </p>
            ) : (
              <p className="hint" style={{ marginTop: 12 }}>
                Grounded in {g!.pillars} pillar{g!.pillars === 1 ? '' : 's'}, {g!.omSections} operating-model
                section{g!.omSections === 1 ? '' : 's'}, {g!.workflows} process{g!.workflows === 1 ? '' : 'es'} and{' '}
                {g!.datasets} dataset{g!.datasets === 1 ? '' : 's'} you can see.
              </p>
            )}

            <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
              {result.candidates.map((c, i) => {
                const meta = dsMeta[c.datasetId];
                return (
                  <div key={`${c.datasetId}-${c.form.name}-${i}`} className="passthrough-note" style={{ flex: '1 1 260px', minWidth: 260 }}>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    {c.why ? <p className="hint" style={{ marginTop: 4 }}>{c.why}</p> : null}
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      {c.pillarId ? <span className="badge">pillar</span> : null}
                      {c.processId ? <span className="badge">process</span> : null}
                      <span className="badge muted">
                        {meta ? `${meta.name} · ${datasetLayerLabel(meta.tier)}` : c.datasetId}
                      </span>
                    </div>
                    <p className="hint mono" style={{ marginTop: 8, fontSize: 12 }}>{shapeSummary(c.form)}</p>
                    {c.crossEntity ? (
                      <p className="hint" style={{ marginTop: 6 }}>
                        Spans datasets — build a curated dataset in Data first: {c.crossEntity.note}
                      </p>
                    ) : null}
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn ghost sm" onClick={() => onPick(c)}>Use this →</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
