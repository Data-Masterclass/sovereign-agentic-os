/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@core/kernel/auth';
import { listComponentsWithStatus } from '@tabs/admin/lib/platform';
import { componentRows } from '@tabs/admin/lib/component-health';
import { config } from '@core/kernel/config';

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
 * client.
 *
 * Each component also carries `version`, `versionSource`, `versionNote` and `health`, read live
 * from the component's own endpoint (`component-health.ts`, design 00 §6) — never typed in; a
 * component that cannot be reached carries the reason instead of a version. Where the
 * tool has a browser-reachable native console — `consoleUrl`, resolved from
 * the RUNTIME env (consoleEnv; an explicit empty value on a deploy means "not
 * publicly exposed" and the UI honestly hides the link). This is what the old
 * /consoles launchpad and /orchestration console card provided.
 */
function consoleUrlFor(id: string): string {
  const urls: Record<string, string> = {
    langfuse: config.langfuseConsoleUrl,
    dagster: config.dagsterConsoleUrl,
  };
  return urls[id] ?? '';
}

export async function GET() {
  try {
    await requireAdmin();
    const components = (await componentRows(await listComponentsWithStatus())).map((c) => ({
      ...c,
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
