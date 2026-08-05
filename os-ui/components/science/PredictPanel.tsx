/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { phraseVerdict, rowToFeatures } from '@/lib/science/ui-format';
import { type ModelSummary, type PredictResult } from './shared';

const DECISION_CLS: Record<PredictResult['decision'], string> = {
  allow: 'ok', deny: 'err', requires_approval: 'warn',
};

/** Preview payload shape (mirrors /api/data/datasets/[id]/preview): rows in COLUMN order. */
type Preview = { columns: string[]; rows: string[][] };

/**
 * The "Try it" front door — the governed `predict` endpoint over ANY deployed model. Simple: a
 * ROW PICKER over the source dataset's GOVERNED preview (`/api/data/datasets/[id]/preview` —
 * rows are arrays in column order); pick a row → the model's features auto-fill → the result is
 * a plain verdict ("High risk — 82%") + one-line interpretation. Developer keeps the raw
 * feature-vector form + the JSON + the traceId. Scores through /api/science/predict AS the
 * signed-in user; a non-deployed model gets an honest pointer to Launch.
 */
export default function PredictPanel({
  model,
  developer = false,
  onResult,
}: {
  model: ModelSummary;
  developer?: boolean;
  onResult?: (r: PredictResult) => void;
}) {
  const [result, setResult] = useState<PredictResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [features, setFeatures] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string> | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pvErr, setPvErr] = useState('');
  const [loadingPv, setLoadingPv] = useState(false);
  const featureNames = model.spec?.features ?? [];
  const datasetId = model.spec?.sourceDatasetId ?? '';
  const deployed = model.buildState === 'deployed';

  // Load the governed preview (Simple row picker) once, when a source dataset id is known.
  useEffect(() => {
    if (developer || !deployed || !datasetId || preview || loadingPv) return;
    setLoadingPv(true);
    fetch(`/api/data/datasets/${encodeURIComponent(datasetId)}/preview?limit=25`, { cache: 'no-store' })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) { setPvErr(j.error ?? 'Could not load example rows'); return; }
        if (Array.isArray(j.columns) && Array.isArray(j.rows)) setPreview({ columns: j.columns, rows: j.rows });
        else setPvErr('No example rows available for this dataset yet.');
      })
      .catch((e) => setPvErr((e as Error).message))
      .finally(() => setLoadingPv(false));
  }, [developer, deployed, datasetId, preview, loadingPv]);

  const score = useCallback(async (vector: Record<string, number>) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/science/predict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.model, account: 'sample-account', features: vector }),
      });
      const j = await res.json();
      if (!res.ok && res.status !== 202 && res.status !== 403) {
        setErr(j.error ?? `predict failed (${res.status})`);
      } else {
        setResult(j as PredictResult);
        onResult?.(j as PredictResult);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [model.model, onResult]);

  const pickRow = useCallback((row: string[]) => {
    if (!preview) return;
    const { vector, display } = rowToFeatures(preview.columns, row, featureNames);
    setPicked(display);
    void score(vector);
  }, [preview, featureNames, score]);

  const scoreVector = useCallback(() => {
    const vector: Record<string, number> = {};
    for (const name of featureNames) {
      const v = Number(features[name]);
      vector[name] = Number.isFinite(v) ? v : 0;
    }
    void score(vector);
  }, [featureNames, features, score]);

  if (!deployed) {
    return (
      <div className="card">
        <div className="muted">
          This model isn’t live yet — use <strong>Launch</strong> to train it and put it live, then come back to try it.
        </div>
      </div>
    );
  }

  const verdict = result ? phraseVerdict(result.score, result.band) : null;

  return (
    <div className="card">
      {/* ---- SIMPLE: row picker over the governed preview ---- */}
      {!developer ? (
        <>
          <div className="muted" style={{ marginBottom: 10 }}>
            Pick a real example from your data — the model scores it for you.
          </div>
          {loadingPv ? (
            <p className="hint"><span className="spin" /> Loading example rows…</p>
          ) : pvErr ? (
            <div className="hint">{pvErr} You can still try the model in Developer mode.</div>
          ) : preview && preview.rows.length ? (
            <div style={{ overflowX: 'auto', maxHeight: 260, border: '1px solid var(--border)', borderRadius: 8 }}>
              <table className="sci-preview">
                <thead>
                  <tr>
                    <th />
                    {preview.columns.map((c) => (
                      <th key={c} className={featureNames.includes(c) ? 'feat' : undefined}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 25).map((row, i) => (
                    <tr key={i}>
                      <td><button className="btn ghost sm" disabled={busy} onClick={() => pickRow(row)}>Score</button></td>
                      {row.map((cell, j) => (
                        <td key={j} className={featureNames.includes(preview.columns[j]) ? 'feat' : undefined}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="hint">No example rows available for this dataset yet.</div>
          )}

          {picked ? (
            <div className="hint" style={{ marginTop: 8 }}>
              Scoring {Object.entries(picked).map(([k, v]) => <span key={k} className="mono" style={{ marginRight: 8 }}>{k}={v || '0'}</span>)}
            </div>
          ) : null}
        </>
      ) : (
        /* ---- DEVELOPER: raw feature-vector form ---- */
        <>
          <div className="muted" style={{ marginBottom: 10 }}>
            Call the governed <code>predict</code> service as yourself. Compiled policy ({model.policy.tier} tier) +
            the OPA <code>predict</code> grant, then a Langfuse trace.
          </div>
          {featureNames.length ? (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {featureNames.map((name) => (
                <label key={name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="comp-label mono" style={{ fontSize: 11 }}>{name}</span>
                  <input className="input sm mono" style={{ width: 130 }} type="number" placeholder="0"
                    value={features[name] ?? ''} onChange={(e) => setFeatures((f) => ({ ...f, [name]: e.target.value }))} />
                </label>
              ))}
            </div>
          ) : null}
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <button className="btn sm" onClick={scoreVector} disabled={busy}>
              {busy ? <span className="spin" /> : 'Try it — predict'}
            </button>
            {result ? <span className={`badge ${DECISION_CLS[result.decision]}`}>OPA {result.decision}</span> : null}
          </div>
        </>
      )}

      {/* ---- The result — plain verdict (Simple) always; JSON + traceId in Developer ---- */}
      {result && result.decision === 'allow' && verdict ? (
        <div className="sci-verdict">
          <div className="sci-verdict-head">{verdict.headline}</div>
          <div className="hint" style={{ marginTop: 4 }}>{verdict.detail}</div>
        </div>
      ) : result && result.decision !== 'allow' ? (
        <div className="hint" style={{ marginTop: 12 }}>
          {result.decision === 'deny' ? 'Not permitted for you on this model' : 'This prediction needs approval'} — {result.reason ?? 'governed by policy'}.
        </div>
      ) : null}

      {developer && result ? (
        <div className="codeblock" style={{ marginTop: 12 }}>
          {[
            '{',
            `  decision:  "${result.decision}",`,
            `  frontDoor: "${result.frontDoor}",`,
            `  tier:      "${result.tier}",`,
            typeof result.score === 'number'
              ? `  score:     ${result.score.toFixed(3)},${result.band ? `  band: "${result.band}",` : ''}`
              : `  reason:    "${result.reason ?? ''}",`,
            `  source:    "${result.source ?? ''}",`,
            `  traceId:   "${result.traceId ?? ''}"`,
            '}',
          ].join('\n')}
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}

      <style jsx>{`
        .sci-preview { border-collapse: collapse; width: 100%; font-size: 12px; }
        .sci-preview th, .sci-preview td { padding: 5px 9px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--border); }
        .sci-preview thead th { position: sticky; top: 0; background: var(--panel); font-weight: 600; }
        .sci-preview .feat { color: var(--gold-text); }
        .sci-verdict {
          margin-top: 14px; padding: 12px 14px; border-radius: 10px;
          background: var(--gold-soft); border: 1px solid var(--gold-line);
        }
        .sci-verdict-head { font-size: 20px; font-weight: 700; }
      `}</style>
    </div>
  );
}
