/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';
import { type ModelSummary, type PredictResult } from './shared';

const DECISION_CLS: Record<PredictResult['decision'], string> = {
  allow: 'ok',
  deny: 'err',
  requires_approval: 'warn',
};

/**
 * The "Try it" front door — the governed `predict` endpoint, generic over ANY DEPLOYED
 * model (the P0 wave made it spec-driven). Renders inputs for the model's OWN feature
 * names and scores through /api/science/predict AS THE SIGNED-IN USER. A model that is not
 * deployed yet gets an honest pointer to the Deploy step.
 *
 * Extracted verbatim from ModelDetail so the staged ModelBuilder can host it in its Predict
 * stage; `onResult` lets the builder record the Predict ✓ and feed the score to the Predict
 * assistant. Behavior (endpoint, payload, decision handling) is preserved exactly.
 */
export default function PredictPanel({
  model,
  onResult,
}: {
  model: ModelSummary;
  /** Fired on every successful call — the builder records Predict done + reads score/band. */
  onResult?: (r: PredictResult) => void;
}) {
  const [result, setResult] = useState<PredictResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [features, setFeatures] = useState<Record<string, string>>({});
  const featureNames = model.spec?.features ?? [];
  const deployed = model.buildState === 'deployed' || model.buildState === 'monitored';

  const call = useCallback(async () => {
    setBusy(true);
    setErr('');
    try {
      const vector: Record<string, number> = {};
      for (const name of featureNames) {
        const v = Number(features[name]);
        vector[name] = Number.isFinite(v) ? v : 0;
      }
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
  }, [featureNames, features, model.model, onResult]);

  if (!deployed) {
    return (
      <div className="card">
        <div className="muted">
          No live serving endpoint for this model yet — train it, then use <strong>Deploy</strong> to create
          its KServe endpoint and enable the governed <code>predict</code> front door.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 10 }}>
        Call the governed <code>predict</code> service as yourself. It runs the compiled policy
        ({model.policy.tier} tier) + the OPA <code>predict</code> grant (the owner always may), then a
        Langfuse trace.
      </div>
      {featureNames.length ? (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {featureNames.map((name) => (
            <label key={name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="comp-label mono" style={{ fontSize: 11 }}>{name}</span>
              <input
                className="input sm mono"
                style={{ width: 130 }}
                type="number"
                placeholder="0"
                value={features[name] ?? ''}
                onChange={(e) => setFeatures((f) => ({ ...f, [name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn sm" onClick={call} disabled={busy}>
          {busy ? <span className="spin" /> : 'Try it — predict'}
        </button>
        {result ? <span className={`badge ${DECISION_CLS[result.decision]}`}>OPA {result.decision}</span> : null}
      </div>
      {result ? (
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
    </div>
  );
}
