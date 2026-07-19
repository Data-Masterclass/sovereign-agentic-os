/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BUILD_STATE, type ModelSummary } from '../shared';

/**
 * The DEPLOY step of the model builder (Science tab). A ▶Deploy button that
 * creates/reconciles the model's per-model KServe InferenceService (POST
 * .../deploy), then polls its live Ready state (GET .../deploy) — trained →
 * deploying → deployed/deploy_failed — cloning TrainStep's submit+poll UX. On
 * success the model serves at its own governed `predict` endpoint and the Predict
 * panel lights up. Owner or in-domain admin only; honest offline error when the
 * cluster is unreachable.
 */
export default function DeployStep({
  model,
  canManage,
  onChanged,
}: {
  model: ModelSummary;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [state, setState] = useState<ModelSummary['buildState']>(model.buildState ?? 'draft');
  const [phase, setPhase] = useState<string>('');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(model.buildState === 'deploy_failed' ? (model.lastDeployError ?? '') : '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const api = `/api/science/model/${encodeURIComponent(model.model)}/deploy`;

  const append = useCallback((line: string) => setLog((l) => [...l.slice(-40), line]), []);

  // Stop any in-flight poll when the panel unmounts.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(api, { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? `poll failed (${res.status})`); return; }
      setPhase(j.phase ?? '');
      const bs = (j.model?.buildState ?? state) as ModelSummary['buildState'];
      setState(bs);
      if (j.phase === 'deployed') {
        append('✓ InferenceService is Ready — the governed predict door is live');
        onChanged();
        return;
      }
      if (j.phase === 'deploy_failed') {
        append(`✗ deploy failed: ${j.status?.reason ?? 'see cluster events'}`);
        setErr(j.model?.lastDeployError ?? 'Deploy failed');
        onChanged();
        return;
      }
      append(`… ${j.status?.reason ?? j.phase ?? 'progressing'}`);
      timer.current = setTimeout(poll, 4000); // keep watching while rolling out
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [api, append, onChanged, state]);

  const deploy = useCallback(async () => {
    setErr('');
    setBusy(true);
    setLog(['▶ applying the InferenceService…']);
    try {
      const res = await fetch(api, { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `deploy failed (${res.status})`);
      setState('deploying');
      setPhase('deploying');
      append(`InferenceService ${j.deploy?.isvc ?? ''} applied → serving ${j.deploy?.storageUri ?? ''}`);
      onChanged();
      timer.current = setTimeout(poll, 2500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api, append, onChanged, poll]);

  const bs = state ? BUILD_STATE[state] : null;
  const deploying = state === 'deploying';
  const deployed = state === 'deployed' || state === 'monitored';
  const deployable = state === 'trained' || state === 'deploy_failed' || deployed;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="comp-label">Deploy the trained model</div>
          <p className="hint" style={{ marginTop: 0, maxWidth: 560 }}>
            Creates the model&apos;s own KServe InferenceService from the trained artifact
            (<code>s3://mlflow/models/{model.model}</code>) and reports readiness from the REAL cluster
            state. Once Ready, the governed <code>predict</code> door serves this model. Owner or
            in-domain admin only.
          </p>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {bs ? (
            <span className="row" style={{ gap: 5, alignItems: 'center' }}>
              <span className={`status-dot ${deploying ? 'warn' : bs.dot}`} />
              <span className="muted">{bs.label}{phase && deploying ? ` · ${phase}` : ''}</span>
            </span>
          ) : null}
          <button className="btn" onClick={deploy} disabled={!canManage || busy || deploying || !deployable}>
            {busy || deploying ? <span className="spin" /> : deployed ? '↻ Redeploy' : '▶ Deploy'}
          </button>
        </div>
      </div>

      {!deployable && !deploying ? (
        <div className="hint" style={{ marginTop: 10 }}>Train the model first — deploy serves the trained artifact.</div>
      ) : null}
      {!canManage ? (
        <div className="hint" style={{ marginTop: 10 }}>Only the model owner or an in-domain admin can deploy this model.</div>
      ) : null}

      {log.length ? (
        <div className="codeblock" style={{ marginTop: 12 }}>{log.join('\n')}</div>
      ) : null}
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}
