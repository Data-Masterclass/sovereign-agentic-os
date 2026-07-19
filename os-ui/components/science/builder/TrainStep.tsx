/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BUILD_STATE, type ModelSummary } from '../shared';

/**
 * The TRAIN step of the model builder (Science tab, Phase 2). A ▶Train button that
 * submits the REAL per-model training Job (POST .../train), then polls the run's
 * live status (GET .../train) — draft → training → trained/failed — reusing the
 * agent-Run activity pattern (a status dot + a rolling log). On success the model
 * carries a registered version + its optimize metric, and the caller advances to
 * Evaluate/Deploy. The Job reads the governed Gold product through a least-privilege
 * Trino principal and uploads a KServe-servable artifact; none of that is client
 * business — the button only submits + watches.
 */
export default function TrainStep({
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
  const [err, setErr] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const api = `/api/science/model/${encodeURIComponent(model.model)}/train`;

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
      if (j.phase === 'succeeded') {
        append('✓ training complete — version registered');
        onChanged();
        return;
      }
      if (j.phase === 'failed') {
        append(`✗ training failed: ${j.status?.reason ?? 'see logs'}`);
        setErr(j.model?.lastTrainingError ?? 'Training failed');
        onChanged();
        return;
      }
      append(`… ${j.phase ?? 'pending'}`);
      timer.current = setTimeout(poll, 4000); // keep watching while running
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [api, append, onChanged, state]);

  const train = useCallback(async () => {
    setErr('');
    setBusy(true);
    setLog(['▶ submitting training job…']);
    try {
      const res = await fetch(api, { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `train failed (${res.status})`);
      setState('training');
      setPhase('pending');
      append(`job ${j.run?.jobName ?? ''} submitted → artifact ${j.run?.storageUri ?? ''}`);
      onChanged();
      timer.current = setTimeout(poll, 2500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api, append, onChanged, poll]);

  const bs = state ? BUILD_STATE[state] : null;
  const training = state === 'training';
  const deploying = state === 'deploying';
  const trained = state === 'trained' || state === 'deploying' || state === 'deploy_failed' || state === 'deployed' || state === 'monitored';

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="comp-label">Train the model</div>
          <p className="hint" style={{ marginTop: 0, maxWidth: 560 }}>
            Runs a governed CPU training job over your <code>{model.spec?.sourceDataProductFqn ?? 'Gold'}</code>{' '}
            data product (read through a least-privilege Trino principal), logs the run to MLflow and
            uploads a KServe-servable artifact. Owner or in-domain admin only.
          </p>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {bs ? (
            <span className="row" style={{ gap: 5, alignItems: 'center' }}>
              <span className={`status-dot ${training ? 'warn' : bs.dot}`} />
              <span className="muted">{bs.label}{phase && training ? ` · ${phase}` : ''}</span>
            </span>
          ) : null}
          <button className="btn" onClick={train} disabled={!canManage || busy || training || deploying}>
            {busy || training ? <span className="spin" /> : trained ? '↻ Retrain' : '▶ Train'}
          </button>
        </div>
      </div>

      {!canManage ? (
        <div className="hint" style={{ marginTop: 10 }}>Only the model owner or an in-domain admin can train this model.</div>
      ) : null}

      {log.length ? (
        <div className="codeblock" style={{ marginTop: 12 }}>{log.join('\n')}</div>
      ) : null}
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}
