/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useApi } from '@/lib/useApi';
import { useToolWindow } from '@/components/ToolWindowProvider';

/**
 * Developer console — the ESCAPE HATCH. The raw Layer-4 stack (JupyterHub, MLflow,
 * Featureform, KServe): a health grid + "open the original app" doors. This USED to
 * be the whole Science tab; in the integrated tab it's demoted to a developer
 * affordance you reach from a model's detail (Developer → Open console) or the tab
 * header. It reads `GET /api/science` UNCHANGED (the 4-service liveness probe).
 */

type Svc = {
  key: string;
  label: string;
  blurb: string;
  consoleUrl: string;
  forward: string;
  up: boolean;
  detail: string;
};
type GateData = { mlEnabled: boolean; services: Svc[]; up: number; total: number };

// Layer-4 tools embeddable same-origin (lib/tool-proxy.ts). JupyterHub needs
// WebSockets (kernels) and KServe has no human UI, so those keep native links.
const EMBEDDABLE_SCIENCE: Record<string, string> = { mlflow: 'MLflow', featureform: 'Featureform' };

export default function DevConsole({ onBack }: { onBack: () => void }) {
  const { data, loading, error } = useApi<GateData>('/api/science');
  const { openTool } = useToolWindow();

  return (
    <>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All models</button>
      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Developer console</h2>
        {data ? (
          <span className={`count-pill${data.up === data.total ? ' ok' : ' warn'}`}>
            {data.up}/{data.total} reachable
          </span>
        ) : null}
      </div>
      <p className="lead" style={{ marginTop: 6 }}>
        The raw Layer-4 stack behind the governed models — for developers who need to drop
        into a notebook, the experiment registry, the feature store, or the serving runtime
        directly. Everyday work happens on the <strong>model tiles</strong>; this is the hatch.
      </p>

      {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}
      {loading && !data ? <div className="stub-page" style={{ marginTop: 16 }}>Pinging Layer-4…</div> : null}

      {data ? (
        <div className="grid" style={{ marginTop: 16 }}>
          {data.services.map((s) => (
            <div className="card launch-card" key={s.key}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ alignItems: 'center', gap: 9 }}>
                  <span className={`status-dot ${s.up ? 'up' : 'down'}`} />
                  <h3 style={{ margin: 0 }}>{s.label}</h3>
                </div>
                <span className={`badge ${s.up ? 'ok' : 'muted'}`}>{s.up ? 'reachable' : s.detail}</span>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>{s.blurb}</div>
              <div className="codeblock">{s.forward}</div>
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                {EMBEDDABLE_SCIENCE[s.key] ? (
                  <button
                    className="btn"
                    onClick={() => openTool(s.key, EMBEDDABLE_SCIENCE[s.key])}
                    style={s.up ? undefined : { opacity: 0.6 }}
                  >
                    Open {s.label}
                  </button>
                ) : s.consoleUrl ? (
                  <a
                    className="btn ghost"
                    href={s.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={s.up ? undefined : { opacity: 0.6 }}
                  >
                    Open {s.label} →
                  </a>
                ) : (
                  <span className="btn ghost" style={{ opacity: 0.5, cursor: 'default' }} title="No browser console on this deployment">
                    No console
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
