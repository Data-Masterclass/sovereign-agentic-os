/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { phraseMetric } from '@/lib/science/ui-format';
import { BUILD_STATE, type ModelSummary, type ModelBuildState, type LaunchStatus, type LaunchStep as Step } from '../shared';

/**
 * The LAUNCH stage — the fused "Train & launch" (Phase B). ONE button reads → trains →
 * publishes; the server auto-deploys on a successful train (the Simple default). We render the
 * server's `LaunchStatus` timeline VERBATIM (its plain step labels), poll the train route while
 * a run is live (its GET returns `launch`), switch to the deploy poll once publishing, and on
 * completion phrase the REAL trained metric in business language (hidden entirely if absent —
 * never fabricated). On `deploy_failed` a Retry calls the standalone deploy route. A failure
 * auto-fetches the plain-language explanation (no button hunt). Owner / in-domain admin only.
 *
 * Developer view (`developer`) surfaces each step's real `detail` (job name, ISVC status) and
 * the MLflow run id — the raw handles the Simple timeline hides.
 */

const DOT: Record<Step['state'], string> = { pending: 'muted', running: 'warn', done: 'up', failed: 'down' };
const GLYPH: Record<Step['state'], string> = { pending: '○', running: '◐', done: '✓', failed: '✗' };

/** A model buildState that means a launch is still in flight (keep polling). */
const IN_FLIGHT = new Set(['training', 'deploying']);

export default function LaunchStep({
  model,
  canManage,
  developer,
  startNonce = 0,
  onChanged,
}: {
  model: ModelSummary;
  canManage: boolean;
  developer: boolean;
  /** Bumped by the Launch chat card's Apply → start the fused train (same governed POST). */
  startNonce?: number;
  onChanged: () => void;
}) {
  const [launch, setLaunch] = useState<LaunchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [explain, setExplain] = useState('');
  const [explaining, setExplaining] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explainedFor = useRef<string>('');
  // The LATEST known phase, so the self-scheduling poll picks the right route (train vs deploy)
  // without relying on a stale closure. Seeded from the model, updated on every status read.
  const phaseRef = useRef<ModelBuildState>(model.buildState ?? 'draft');

  const bs = model.buildState ?? 'draft';
  const trainApi = `/api/science/model/${encodeURIComponent(model.model)}/train`;
  const deployApi = `/api/science/model/${encodeURIComponent(model.model)}/deploy`;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Poll whichever route owns the live phase: train while training, deploy while deploying. Stable
  // (reads phaseRef, not closure state) so a scheduled tick always hits the current route.
  const poll = useCallback(async () => {
    const api = phaseRef.current === 'deploying' ? deployApi : trainApi;
    try {
      const res = await fetch(api, { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok) { setErr(j.error ?? `poll failed (${res.status})`); return; }
      const ls = j.launch as LaunchStatus | undefined;
      if (ls) setLaunch(ls);
      const nextPhase = (ls?.phase ?? j.phase ?? phaseRef.current) as ModelBuildState;
      phaseRef.current = nextPhase;
      if (IN_FLIGHT.has(nextPhase)) {
        timer.current = setTimeout(poll, 3500);
      } else {
        onChanged(); // terminal (deployed / deploy_failed / draft-after-fail) → refresh the model
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [deployApi, trainApi, onChanged]);

  const start = useCallback(async () => {
    setErr('');
    setExplain('');
    setBusy(true);
    try {
      const res = await fetch(trainApi, { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `launch failed (${res.status})`);
      const ls = j.launch as LaunchStatus | undefined;
      if (ls) setLaunch(ls);
      phaseRef.current = (ls?.phase ?? 'training') as ModelBuildState;
      onChanged();
      timer.current = setTimeout(poll, 2500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [trainApi, onChanged, poll]);

  // deploy_failed retry uses the standalone deploy route (training already succeeded).
  const retryDeploy = useCallback(async () => {
    setErr('');
    setExplain('');
    setBusy(true);
    try {
      const res = await fetch(deployApi, { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `deploy failed (${res.status})`);
      const ls = j.launch as LaunchStatus | undefined;
      if (ls) setLaunch(ls);
      phaseRef.current = (ls?.phase ?? 'deploying') as ModelBuildState;
      onChanged();
      timer.current = setTimeout(poll, 2500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [deployApi, onChanged, poll]);

  // The Launch chat card's Apply bumps startNonce → start the fused train (same governed POST as
  // the button). Guarded to the startable states so a stray bump never double-submits a live run.
  const startedNonce = useRef(0);
  useEffect(() => {
    if (startNonce > 0 && startNonce !== startedNonce.current && canManage && (bs === 'draft' || bs === 'trained')) {
      startedNonce.current = startNonce;
      void start();
    }
    // `start` is stable enough; we intentionally key only on the nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNonce]);

  // The live status: the polled one, or the one derived from the persisted model on open.
  const status: LaunchStatus | null = launch ?? deriveFromModel(model);
  const failureReason = status?.error ?? model.lastTrainingError ?? model.lastDeployError ?? '';
  const failed = status?.phase === 'deploy_failed' || (status?.phase === 'draft' && !!model.lastTrainingError);
  // A publish failure whose reason carries the malformed serving-runtime signature is an ADMIN fix,
  // not a user retry — say so specifically instead of the generic "couldn't finish launching".
  const servingRuntimeBroken =
    status?.phase === 'deploy_failed' &&
    /--model_name|serving runtime is misconfigured|no runtime found to support/i.test(failureReason);
  const failHeader = servingRuntimeBroken
    ? 'Serving runtime misconfigured — see your platform admin.'
    : status?.phase === 'deploy_failed'
    ? 'Couldn’t finish publishing the model.'
    : 'Couldn’t finish training the model.';

  // Auto-fetch the plain-language failure explanation once per distinct reason (no button hunt).
  // Uses the governed LAUNCH-stage assistant, which is grounded server-side in THIS model's real
  // signals (captured error + training run log tail + live KServe status) — so it can diagnose the
  // cause, not just restate the raw reason. We pass the reason as the user turn and read `message`.
  useEffect(() => {
    if (!failed || !failureReason || explainedFor.current === failureReason) return;
    explainedFor.current = failureReason;
    setExplaining(true);
    const kind = status?.phase === 'deploy_failed' ? 'publishing (deploy)' : 'training';
    fetch('/api/science/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stage: 'launch',
        model: model.model,
        messages: [{ role: 'user', content: `Launching this model failed at ${kind}. Explain what went wrong and what I should do next.` }],
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.message) setExplain(d.message as string); })
      .catch(() => { /* honest no-op — the raw reason is still shown */ })
      .finally(() => setExplaining(false));
  }, [failed, failureReason, status?.phase, model.model]);

  const deployed = bs === 'deployed';
  const inFlight = IN_FLIGHT.has(status?.phase ?? bs) || busy;
  const metricLine = phraseMetric(model.metrics?.primaryMetric ?? model.spec?.optimizeMetric, model.metrics?.primary);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="comp-label">Train &amp; launch</div>
          <p className="hint" style={{ marginTop: 0, maxWidth: 560 }}>
            One step: we read your <code>{model.spec?.sourceDataProductFqn ?? 'data'}</code>, train the model, and
            put it live so you can use it. This runs on governed infrastructure as you.
          </p>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {deployed ? (
            <span className="badge ok">Live</span>
          ) : failed ? (
            <button
              className="btn"
              onClick={retryDeploy}
              disabled={!canManage || busy || servingRuntimeBroken}
              title={servingRuntimeBroken ? 'A platform admin must fix the serving runtime before this can succeed.' : undefined}
            >
              {busy ? <span className="spin" /> : '↻ Retry'}
            </button>
          ) : (
            <button className="btn" onClick={start} disabled={!canManage || inFlight}>
              {inFlight ? <span className="spin" /> : deployed ? '↻ Retrain & relaunch' : 'Train & launch'}
            </button>
          )}
        </div>
      </div>

      {!canManage ? (
        <div className="hint" style={{ marginTop: 10 }}>Only the model owner or an in-domain admin can launch this model.</div>
      ) : null}

      {/* The plain timeline — rendered verbatim from the server's LaunchStatus. */}
      {status ? (
        <ol className="sci-timeline" aria-label="Launch progress">
          {status.steps.map((s) => (
            <li key={s.key} className="sci-tl-step">
              <span className={`status-dot ${DOT[s.state]}`} aria-hidden />
              <span className="sci-tl-glyph" aria-hidden>{GLYPH[s.state]}</span>
              <span className="sci-tl-label">{s.label}</span>
              {developer && s.detail ? <span className="mono sci-tl-detail">{s.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {/* On success: the REAL metric phrased in business language (hidden if absent). */}
      {deployed && metricLine ? (
        <div className="sci-metric-note">{metricLine}</div>
      ) : null}

      {/* On failure: the honest reason + its auto-fetched plain-language explanation. */}
      {failed ? (
        <div className="error" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600 }}>{failHeader}</div>
          {explaining ? (
            <div className="hint" style={{ marginTop: 6 }}><span className="spin" /> Explaining…</div>
          ) : explain ? (
            <p className="hint" style={{ marginTop: 6, whiteSpace: 'pre-wrap', color: 'inherit' }}>{explain}</p>
          ) : null}
          {failureReason ? <div className="mono" style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{failureReason}</div> : null}
        </div>
      ) : null}

      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}

      {developer ? (
        <div className="grant-block" style={{ marginTop: 14 }}>
          <div className="comp-label">Developer</div>
          <p className="hint" style={{ marginTop: 4 }}>
            Job / serving handles the Simple timeline hides.
          </p>
          <div className="tile-meta muted" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
            <span>build state: <span className="mono">{bs}</span> ({BUILD_STATE[bs].label})</span>
            {model.trainingJob ? <span>training job: <span className="mono">{model.trainingJob}</span></span> : null}
            {model.kserveService ? <span>InferenceService: <span className="mono">{model.kserveService}</span></span> : null}
            {model.mlflowRunId ? <span>MLflow run: <span className="mono">{model.mlflowRunId}</span></span> : null}
          </div>
        </div>
      ) : null}

      <style jsx>{`
        .sci-timeline { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
        .sci-tl-step { display: flex; align-items: center; gap: 10px; }
        .sci-tl-glyph { width: 14px; text-align: center; opacity: 0.8; }
        .sci-tl-label { font-size: 14px; }
        .sci-tl-detail { font-size: 11px; opacity: 0.7; margin-left: auto; }
        .sci-metric-note {
          margin-top: 14px; padding: 10px 12px; border-radius: 8px;
          background: var(--gold-soft); border: 1px solid var(--gold-line);
          font-size: 13.5px; line-height: 1.5;
        }
      `}</style>
    </div>
  );
}

/**
 * Derive a LaunchStatus from a settled persisted model when we have no polled one yet (opening
 * an existing model). Mirrors the server's `computeLaunchStatus` step layout so the timeline
 * reads consistently before the first poll. Client-side; never fabricates a metric or a run.
 */
function deriveFromModel(m: ModelSummary): LaunchStatus | null {
  const bs = m.buildState ?? 'draft';
  const step = (key: Step['key'], label: string, state: Step['state'], detail?: string): Step => ({ key, label, state, detail });
  const read = step('read', 'Reading your data', 'pending');
  const train = step('train', 'Training the model', 'pending');
  const publish = step('publish', 'Putting it live', 'pending');
  switch (bs) {
    case 'draft':
      if (m.lastTrainingError) return { phase: 'draft', launched: false, steps: [{ ...read, state: 'done' }, { ...train, state: 'failed', detail: m.lastTrainingError }, publish], error: m.lastTrainingError };
      return null; // nothing launched yet — show the button, no timeline
    case 'training':
      return { phase: bs, launched: false, steps: [{ ...read, state: 'done' }, { ...train, state: 'running', detail: m.trainingJob }, publish] };
    case 'trained':
      return { phase: bs, launched: false, steps: [{ ...read, state: 'done' }, { ...train, state: 'done' }, publish] };
    case 'deploying':
      return { phase: bs, launched: false, steps: [{ ...read, state: 'done' }, { ...train, state: 'done' }, { ...publish, state: 'running', detail: m.kserveService }] };
    case 'deployed':
      return { phase: bs, launched: true, steps: [{ ...read, state: 'done' }, { ...train, state: 'done' }, { ...publish, state: 'done', detail: m.kserveService }] };
    case 'deploy_failed':
      return { phase: bs, launched: false, steps: [{ ...read, state: 'done' }, { ...train, state: 'done' }, { ...publish, state: 'failed', detail: m.lastDeployError }], error: m.lastDeployError };
    default:
      return null;
  }
}
