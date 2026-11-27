/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Suggest-metrics panel — 3 to 6 grounded metric candidates from the user's context
 * USER STORY: As a creator who does not know where to start I want suggested metrics based on
 *             my operating model, processes and datasets so that I can pre-fill a metric in one
 *             click.
 * ARCHITECTURE:
 *   - Client component (default export `SuggestPanel`); calls `/api/metrics/assistant` and
 *     lists datasets from `/api/data/datasets`. Types mirror `@tabs/metrics/lib/suggest`.
 *   - Works with no dataset chosen; the grounding banner names what informed the answer, and an
 *     offline assistant shows the route's 503/402 message rather than a made-up suggestion.
 *   - Not imported by any other module at present.
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import { type DatasetGroups, useDatasetLayerLabel } from '@tabs/metrics/ui/shared';

/** Mirrors lib/metrics/suggest.ts — the client only needs to READ these (types, not logic). */
type MetricFormLite = { name: string; aggregation: string; column: string; dimensions: string[] };
type CrossEntity = { note: string; datasets: string[] };
export type Candidate = {
  name: string;
  description: string;
  why: string;
  processId?: string;
  datasetId: string;
  form: MetricFormLite;
  crossEntity?: CrossEntity;
};
type Grounding = { omSections: number; workflows: number; datasets: number };
type SuggestResult = { candidates: Candidate[]; grounding: Grounding };

/** A one-line human summary of the measure shape (no jargon). */
function shapeSummary(form: MetricFormLite, t: ReturnType<typeof useTranslations<'metrics'>>): string {
  const agg =
    form.aggregation === 'count' ? t('suggest.shape.count')
    : form.aggregation === 'count_distinct' || form.aggregation === 'count_distinct_approx'
      ? (form.column ? t('suggest.shape.unique', { column: form.column }) : t('suggest.shape.uniqueValues'))
    : form.aggregation === 'number' ? t('suggest.shape.ratio')
    : t('suggest.shape.agg', {
      agg: form.aggregation,
      aggLabel: `${form.aggregation[0].toUpperCase()}${form.aggregation.slice(1)}`,
      column: form.column || '—',
    });
  return form.dimensions.length ? t('suggest.shape.by', { shape: agg, dimensions: form.dimensions.join(', ') }) : agg;
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
  const t = useTranslations('metrics');
  const layerLabel = useDatasetLayerLabel();
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
      if (!res.ok) throw new Error((data.error as string | undefined) ?? t('requestFailed', { status: String(res.status) }));
      setResult({
        candidates: Array.isArray(data.candidates) ? (data.candidates as Candidate[]) : [],
        grounding: (data.grounding as Grounding) ?? { omSections: 0, workflows: 0, datasets: 0 },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const g = result?.grounding;
  const contextThin = !!g && g.omSections === 0 && g.workflows === 0;

  return (
    <div className="guided-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <span className="comp-label" style={{ margin: 0 }}>{t('suggest.title')}</span>
          <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
            {t('suggest.intro')}
          </p>
        </div>
        <button className="btn" onClick={ask} disabled={busy} style={{ whiteSpace: 'nowrap' }}>
          {busy ? <span className="spin" /> : t('suggest.button')}
        </button>
      </div>

      <input
        placeholder={t('suggest.goalPlaceholder')}
        value={goal}
        onChange={(e) => onGoal(e.target.value)}
        style={{ marginTop: 10, width: '100%', maxWidth: 520 }}
      />

      {error ? (
        <div className="stub-page" style={{ marginTop: 12 }}>
          {t('suggest.unavailable', { error })}
        </div>
      ) : null}

      {result ? (
        result.candidates.length === 0 ? (
          <div className="stub-page" style={{ marginTop: 12 }}>
            {g && g.datasets === 0
              ? t('suggest.noDatasets')
              : t('suggest.noSuggestions')}
          </div>
        ) : (
          <>
            {contextThin ? (
              <p className="hint" style={{ marginTop: 12 }}>
                {t.rich('suggest.dataOnly', { link: (c) => <a href="/knowledge">{c}</a> })}
              </p>
            ) : (
              <p className="hint" style={{ marginTop: 12 }}>
                {t('suggest.grounded', { sections: g!.omSections, workflows: g!.workflows, datasets: g!.datasets })}
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
                      {c.processId
 ? <span className="badge">{t('suggest.processBadge')}</span> : null}
                      <span className="badge muted">
                        {meta ? `${meta.name} · ${layerLabel(meta.tier)}` : c.datasetId}
                      </span>
                    </div>
                    <p className="hint mono" style={{ marginTop: 8, fontSize: 12 }}>{shapeSummary(c.form, t)}</p>
                    {c.crossEntity ? (
                      <p className="hint" style={{ marginTop: 6 }}>
                        {t('suggest.crossEntity', { note: c.crossEntity.note })}
                      </p>
                    ) : null}
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn ghost sm" onClick={() => onPick(c)}>{t('suggest.use')}</button>
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
