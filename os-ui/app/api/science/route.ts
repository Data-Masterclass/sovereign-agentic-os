/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Science (Layer 4) -> JupyterHub / MLflow / Featureform / KServe. Layer 4 is
 * off by default, so we ping each backend server-side and degrade gracefully:
 * any HTTP response (even 401/404) means "reachable"; a network error means the
 * service is absent. Backend URLs stay server-side; the browser only gets the
 * up/down result and the (browser-reachable) console URL to open.
 */

type Svc = {
  key: string;
  label: string;
  blurb: string;
  pingUrl: string;
  consoleUrl: string;
  forward: string;
};

const SERVICES: Svc[] = [
  {
    key: 'jupyterhub',
    label: 'JupyterHub',
    blurb: 'Multi-user notebooks — work in Python against governed data.',
    pingUrl: `${config.jupyterhubUrl}/hub/health`,
    consoleUrl: config.jupyterhubConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/proxy-public 8000:80',
  },
  {
    key: 'mlflow',
    label: 'MLflow',
    blurb: 'Experiment tracking + model registry — train, track, compare runs.',
    pingUrl: `${config.mlflowUrl}/health`,
    consoleUrl: config.mlflowConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/mlflow 5000:5000',
  },
  {
    key: 'featureform',
    label: 'Featureform',
    blurb: 'Feature store — define and serve features for training + inference.',
    pingUrl: `${config.featureformUrl}/`,
    consoleUrl: config.featureformConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/featureform 7878:7878',
  },
  {
    key: 'kserve',
    label: 'KServe',
    blurb: 'Model inference serving — deploy trained models behind an endpoint.',
    pingUrl: `${config.kserveUrl}/`,
    consoleUrl: config.kserveConsoleUrl,
    forward: 'kubectl -n agentic-os port-forward svc/kserve 8080:80',
  },
];

async function ping(s: Svc) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(s.pingUrl, { cache: 'no-store', signal: ctrl.signal });
    // Any HTTP answer = reachable; 2xx/3xx/401/403 = healthy enough to open.
    const up = res.status < 500;
    return {
      key: s.key,
      label: s.label,
      blurb: s.blurb,
      consoleUrl: s.consoleUrl,
      forward: s.forward,
      up,
      detail: `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      key: s.key,
      label: s.label,
      blurb: s.blurb,
      consoleUrl: s.consoleUrl,
      forward: s.forward,
      up: false,
      detail: (e as Error).name === 'AbortError' ? 'timeout' : 'absent',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const services = await Promise.all(SERVICES.map(ping));
  const up = services.filter((s) => s.up).length;
  return NextResponse.json({ services, up, total: services.length });
}
