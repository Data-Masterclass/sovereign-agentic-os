/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { listComponentsWithStatus } from '@/lib/platform';
import { versionFor } from '@/lib/platform-admin/components-extra';
import { config } from '@/lib/core/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Components surface — live stack registry + status.
 *
 * NATIVE implementation (no proxy). The OS UI server reads each component's
 * workload straight from the in-cluster Kubernetes API using the pod's scoped
 * ServiceAccount, and answers with one object per component:
 *   { id, name, layer, status, svc, port, ns, lport, ui, url_path, login,
 *     summary, toggle }
 * The browser only ever talks to THIS route — the k8s token never reaches the
 * client. (Formerly this proxied the standalone admin-console service.)
 *
 * Nav consolidation: each component also carries `version` and — where the
 * tool has a browser-reachable native console — `consoleUrl`, resolved from
 * the RUNTIME env (consoleEnv; an explicit empty value on a deploy means "not
 * publicly exposed" and the UI honestly hides the link). This is what the old
 * /consoles launchpad and /orchestration console card provided.
 */
function consoleUrlFor(id: string): string {
  const urls: Record<string, string> = {
    langfuse: config.langfuseConsoleUrl,
    superset: config.supersetUrl,
    argocd: config.argocdUrl,
    openmetadata: config.openmetadataUrl,
    dagster: config.dagsterConsoleUrl,
    forgejo: config.forgejoConsoleUrl,
    'opensearch-dashboards': config.opensearchDashboardsUrl,
    cube: config.cubeConsoleUrl,
    jupyterhub: config.jupyterhubConsoleUrl,
    mlflow: config.mlflowConsoleUrl,
    featureform: config.featureformConsoleUrl,
  };
  return urls[id] ?? '';
}

export async function GET() {
  try {
    await requireAdmin();
    const components = (await listComponentsWithStatus()).map((c) => ({
      ...c,
      version: versionFor(c.id),
      consoleUrl: consoleUrlFor(c.id),
    }));
    return NextResponse.json({ components });
  } catch (e) {
    // Honor an auth status (401/403) from requireAdmin; otherwise it's a 502.
    const status = (e as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
    return NextResponse.json(
      { error: `Could not read component status: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
