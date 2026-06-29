/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useUser } from '@/lib/useUser';

type Svc = {
  key: string;
  label: string;
  blurb: string;
  consoleUrl: string;
  forward: string;
  up: boolean;
  detail: string;
};
type Data = { services: Svc[]; up: number; total: number };

type Stage = {
  key: string;
  n: number;
  label: string;
  desc: string;
  backend: string;
  status: 'live' | 'ready' | 'pending';
  actor: 'Creator' | 'Builder' | 'User' | 'Platform';
};
type FeatureRow = { name: string; entity: string; offline: string; online: string };
type ModelVersion = {
  version: string;
  stage: 'Staging' | 'Production' | 'Archived';
  auc: number;
  certified: boolean;
  runId: string;
};
type ChurnData = {
  model: string;
  dataProduct: string;
  featureSet: string;
  backends: { featureform: boolean; mlflow: boolean; kserve: boolean };
  stages: Stage[];
  featuresLive: boolean;
  registryLive: boolean;
  features: FeatureRow[];
  versions: ModelVersion[];
  sample: { account: string; features: Record<string, number> };
};

type PredictResult = {
  decision: 'allow' | 'deny' | 'requires_approval';
  policy: string;
  reason?: string;
  account?: string;
  score?: number;
  band?: 'low' | 'medium' | 'high';
  source?: 'kserve' | 'seed-offline';
  modelVersion?: string;
  traceId?: string;
};

export default function SciencePage() {
  const { data, loading, error, reload } = useApi<Data>('/api/science');

  return (
    <>
      <PageHeader title="Science" crumb="Layer 4 — features, models & notebooks (ML, not LLMs)" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Traditional ML / data science: work in notebooks (JupyterHub), build features
            (Featureform), train and track models (MLflow), and deploy them for inference
            (KServe). This is the <strong>Layer-4</strong> capability — off unless the domain
            does ML (<code>ml.enabled=false</code> by default, GPU off), so services below show
            as <em>absent</em> until enabled. Health is pinged server-side; consoles open in their
            own UI.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {data ? (
          <>
            <div className="section-title">
              Layer-4 stack
              <span className={`count-pill${data.up === data.total ? ' ok' : ' warn'}`}>
                {data.up}/{data.total} reachable
              </span>
            </div>
            <div className="grid">
              {data.services.map((s) => (
                <div className="card launch-card" key={s.key}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="row" style={{ alignItems: 'center', gap: 9 }}>
                      <span className={`status-dot ${s.up ? 'up' : 'down'}`} />
                      <h3 style={{ margin: 0 }}>{s.label}</h3>
                    </div>
                    <span className={`badge ${s.up ? 'ok' : 'muted'}`}>
                      {s.up ? 'reachable' : s.detail}
                    </span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>{s.blurb}</div>
                  <div className="codeblock">{s.forward}</div>
                  <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                    <a
                      className="btn ghost"
                      href={s.consoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={s.up ? undefined : { opacity: 0.6 }}
                    >
                      Open {s.label} →
                    </a>
                  </div>
                </div>
              ))}
            </div>

            <ChurnSlice />
          </>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Pinging Layer-4 services…</div>
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ churn slice */

const STAGE_BADGE: Record<Stage['status'], { cls: string; label: string }> = {
  live: { cls: 'ok', label: 'live' },
  ready: { cls: 'muted', label: 'ready' },
  pending: { cls: 'warn', label: 'pending deploy' },
};

function ChurnSlice() {
  const { data, loading } = useApi<ChurnData>('/api/science/churn');
  const { user } = useUser();
  const isBuilder = user?.role === 'builder' || user?.role === 'admin';

  const [pred, setPred] = useState<PredictResult | null>(null);
  const [running, setRunning] = useState(false);
  const [predErr, setPredErr] = useState('');

  async function runPredict() {
    setRunning(true);
    setPredErr('');
    setPred(null);
    try {
      const res = await fetch('/api/science/predict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: data?.sample.account ?? 'ACME' }),
      });
      const body = await res.json();
      if (!res.ok && res.status !== 202 && res.status !== 403) {
        setPredErr(body.error ?? `predict failed (${res.status})`);
      } else {
        setPred(body as PredictResult);
      }
    } catch (e) {
      setPredErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  if (loading || !data) {
    return (
      <>
        <div className="section-title">Churn model — vertical slice</div>
        <div className="stub-page" style={{ marginTop: 8 }}>Loading the churn golden path…</div>
      </>
    );
  }

  return (
    <>
      <div className="section-title">
        Churn model — vertical slice
        <span className="count-pill">{data.model}</span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        From a governed data product (<code>{data.dataProduct}</code>) to a deployed, governed{' '}
        <code>predict</code> tool. Each stage shows <span className="badge ok">live</span> when its
        backend is reachable and <span className="badge muted">ready</span> (deterministic seed)
        when Layer-4 is off — so the path is demonstrable end-to-end offline.
      </p>

      {/* 8-stage golden path */}
      <div style={{ display: 'grid', gap: 10 }}>
        {data.stages.map((g) => {
          const b = STAGE_BADGE[g.status];
          return (
            <div className="golden" key={g.key}>
              <span className="ico">{g.n}</span>
              <div style={{ flex: 1 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600 }}>{g.label}</div>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span className="badge muted">{g.actor}</span>
                    <span className={`badge ${b.cls}`}>{b.label}</span>
                  </div>
                </div>
                <div className="muted">{g.desc}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2, opacity: 0.8 }}>
                  {g.backend}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Features (Featureform) */}
      <div className="section-title" style={{ marginTop: 20 }}>
        Features — <code>{data.featureSet}</code>
        <span className={`count-pill${data.featuresLive ? ' ok' : ''}`}>
          {data.featuresLive ? 'Featureform live' : 'seed'}
        </span>
      </div>
      <div className="card">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr className="muted" style={{ textAlign: 'left' }}>
              <th style={{ padding: '4px 8px' }}>Feature</th>
              <th style={{ padding: '4px 8px' }}>Entity</th>
              <th style={{ padding: '4px 8px' }}>Offline (Iceberg)</th>
              <th style={{ padding: '4px 8px' }}>Online (Valkey)</th>
            </tr>
          </thead>
          <tbody>
            {data.features.map((f) => (
              <tr key={f.name}>
                <td style={{ padding: '4px 8px' }}><code>{f.name}</code></td>
                <td style={{ padding: '4px 8px' }}>{f.entity}</td>
                <td style={{ padding: '4px 8px' }} className="muted">{f.offline}</td>
                <td style={{ padding: '4px 8px' }} className="muted">{f.online}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Model registry (MLflow) */}
      <div className="section-title" style={{ marginTop: 20 }}>
        Model registry — versions & stages
        <span className={`count-pill${data.registryLive ? ' ok' : ''}`}>
          {data.registryLive ? 'MLflow live' : 'seed'}
        </span>
      </div>
      <div className="grid">
        {data.versions.map((v) => (
          <div className="card" key={v.version}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>
                {data.model} <span className="muted">{v.version}</span>
              </h3>
              <span className={`badge ${v.stage === 'Production' ? 'ok' : 'muted'}`}>{v.stage}</span>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              AUC <strong>{v.auc.toFixed(3)}</strong> · run <code>{v.runId}</code>
            </div>
            <div className="row" style={{ marginTop: 10, gap: 6, alignItems: 'center' }}>
              {v.certified ? (
                <span className="badge ok">Certified · Production</span>
              ) : isBuilder ? (
                <button className="btn ghost" disabled title="Certify + go-live (Builder gate)">
                  Certify + go-live
                </button>
              ) : (
                <span className="badge muted">Builder certifies go-live</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Certify + go-live is the Builder gate — it maps to the artifact promote ladder
        (Personal→Shared→Certified) and the MLflow Staging→Production transition, recorded + audited.
        {isBuilder
          ? ' You are signed in as a Builder/Admin.'
          : ' Sign in as a Builder to action go-live.'}
      </div>

      {/* Consume — governed predict tool */}
      <div className="section-title" style={{ marginTop: 20 }}>
        Consume — governed <code>predict</code> tool
        <span className={`count-pill${data.backends.kserve ? ' ok' : ''}`}>
          {data.backends.kserve ? 'KServe live' : 'offline seed'}
        </span>
      </div>
      <div className="card">
        <div className="muted">
          The deployed model is exposed as a governed <code>predict</code> MCP tool — OPA-gated and
          Langfuse-traced like any other agent tool. The Sales Assistant calls it (principal{' '}
          <code>sales-assistant</code>, granted <code>predict</code>) to flag at-risk accounts; online
          features come from Featureform/Valkey. This runs the tool against{' '}
          <strong>{data.sample.account}</strong>.
        </div>
        <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
          <button className="btn" onClick={runPredict} disabled={running}>
            {running ? <span className="spin" /> : `Run predict on ${data.sample.account}`}
          </button>
          {pred ? (
            <span
              className={`badge ${
                pred.decision === 'allow' ? 'ok' : pred.decision === 'deny' ? 'muted' : 'warn'
              }`}
            >
              OPA {pred.decision} · {pred.policy}
            </span>
          ) : null}
        </div>

        {predErr ? <div className="error" style={{ marginTop: 10 }}>{predErr}</div> : null}

        {pred && pred.decision === 'allow' && typeof pred.score === 'number' ? (
          <div className="codeblock" style={{ marginTop: 12 }}>
            {[
              '{',
              `  account:      "${pred.account}",`,
              `  churn_score:  ${pred.score.toFixed(3)},`,
              `  risk_band:    "${pred.band}",`,
              `  model:        "${data.model} ${pred.modelVersion ?? ''}".trim(),`,
              `  source:       "${pred.source}",`,
              `  trace_id:     "${pred.traceId}"`,
              '}',
            ].join('\n')}
          </div>
        ) : null}
        {pred && pred.decision !== 'allow' ? (
          <div className="hint" style={{ marginTop: 10 }}>
            {pred.reason ?? 'Held by policy.'} (trace <code>{pred.traceId}</code>)
          </div>
        ) : null}
      </div>

      <div className="hint" style={{ marginTop: 16 }}>
        Set <code>JUPYTERHUB_URL</code>, <code>MLFLOW_URL</code>, <code>FEATUREFORM_URL</code>,{' '}
        <code>KSERVE_URL</code> to the in-cluster Services (server-side health) and the matching{' '}
        <code>*_CONSOLE_URL</code> for the browser links. Defaults assume Layer-4 is deployed in{' '}
        <code>agentic-os</code>.
      </div>
    </>
  );
}
