/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Software panels — per app: the honest status word, the security scan of its newest
 *             review card (engine, severity), pod health, and the share of log lines that are errors
 * USER STORY: As an app owner or a builder I want to know which apps really serve, what the scan found and
 *             which engine ran it, whether the pods are healthy and how noisy the logs are — and be told when a
 *             source did not answer instead of seeing zeros or "clean".
 * ARCHITECTURE:
 *   - Server-only, READ-ONLY. Apps = the Software tab's own scoped list (`listAppsForUser`) with each app's newest
 *     review card, injected through `sources.ts`; the status word is the tab's `deployStatusOf`, the scan is what the
 *     review recorded (Trivy, or none: `no_verdict`).
 *   - Pods = the Kubernetes API through the existing `k8s()` client: ONE list in the runner namespace by label
 *     `app.kubernetes.io/part-of=sovereign-os-apps`, folded per runner. Only image apps have pods (a declarative or
 *     runtime app is served by the OS: `pods: null`, not "0 pods"). Cluster unreachable or refusing ⇒ `unavailable`.
 *   - Error rate = VictoriaLogs' own count of lines and of lines containing "error", per pod of the ASKED runners
 *     (the query names only them), folded per app. No lines ⇒ no rate (`null`), never 0%.
 *   - Not available upstream (said in the payload): CI/CD results — the stack has no CI runner, image builder or
 *     registry, so nothing records a build or a test run.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { k8s } from '@core/infra/k8s';
import { logsQuery } from '@core/adapters/victoria-logs/query';
import { monitoringSources, SOURCES_MISSING, type ScanFacts, type SoftwareRow } from '@tabs/monitoring/lib/panels/sources';
import {
  appLogQuery, foldAppLogs, live, podFactsOf, podStateOf, runnerOfPod, unavailable, worstPodState,
  type AppLogCounts, type NotUpstream, type PodFacts, type PodState, type SourceState,
} from '@tabs/monitoring/lib/panels/panels-core';

export type ScanVerdict = 'passed' | 'failed' | 'no_verdict';

export type AppScan = {
  verdict: ScanVerdict;
  engine: string | null;
  mode: string;
  reason: string | null;
  notRun: string[];
  bySeverity: ScanFacts['bySeverity'];
  byCategory: Record<string, number>;
  /** Severity counts cover only the listed findings (the review capped the list). */
  truncated: boolean;
  scannedAt: string;
};

export type AppPods = { state: PodState | 'no_pods'; items: (PodFacts & { state: PodState })[] };

export type SoftwareApp = {
  id: string;
  name: string;
  domain: string;
  scope: 'mine' | 'domain' | 'marketplace';
  serveMode: 'spec' | 'runtime' | 'image';
  status: { label: string; servedUrl: string | null };
  softwareUrl: string;
  review: { requestedAt: string; decision: string; decidedAt: string | null } | null;
  scan: AppScan | null;
  /** null = the app has no pod (declarative / runtime) or Kubernetes did not answer (see `sources.pods`). */
  pods: AppPods | null;
  /** null = not an image app's log, or VictoriaLogs did not answer (see `sources.logs`). */
  logs: AppLogCounts | null;
};

export type SoftwareView = {
  view: 'software';
  generatedAt: string;
  sources: { inventory: SourceState; pods: SourceState; logs: SourceState };
  summary: { apps: number; serving: number; scanFailed: number; noVerdict: number; podsUnhealthy: number } | null;
  apps: SoftwareApp[];
  /** The runner namespace and the exact log query, so a reviewer can run them. */
  queries: { namespace: string; podSelector: string; logsql: string | null };
  notUpstream: NotUpstream[];
};

const NOT_UPSTREAM: NotUpstream[] = [
  { panel: 'CI/CD results', reason: 'The OS has no CI runner, image builder or registry — an image app serves an image the operator built elsewhere — so no build or test run is recorded. The nearest recorded facts are shown instead: the review card’s scan and the deploy decision.' },
  { panel: 'Scan history', reason: 'Only the scan of each app’s newest review card is kept; earlier scans are not shown.' },
];

const POD_SELECTOR = 'app.kubernetes.io/part-of=sovereign-os-apps';

const scanOf = (s: ScanFacts): AppScan => ({
  verdict: s.unavailable ? 'no_verdict' : s.passed ? 'passed' : 'failed',
  engine: s.engine, mode: s.mode, reason: s.reason, notRun: s.notRun, bySeverity: s.bySeverity, byCategory: s.byCategory, truncated: s.truncated, scannedAt: s.scannedAt,
});

/** The Software list rule: Personal = own, Domain = the viewer's domains, Marketplace (certified) = everyone; an admin sees all. */
function inScope(r: SoftwareRow, user: CurrentUser): boolean {
  if (user.role === 'admin' || r.scope === 'marketplace') return true;
  return !r.domain || user.domains.includes(r.domain);
}

const attention = (a: SoftwareApp): number =>
  (a.scan?.verdict === 'failed' ? 4 : 0) + (a.pods && ['crash_looping', 'image_pull_failed', 'failed', 'not_ready'].includes(a.pods.state) ? 4 : 0) + (a.scan?.verdict === 'no_verdict' ? 1 : 0) + ((a.logs?.errorRate ?? 0) > 0.05 ? 2 : 0);

export async function softwareView(user: CurrentUser, nowMs = Date.now()): Promise<SoftwareView> {
  const src = monitoringSources();
  const listed = src?.software
    ? await src.software({ id: user.id, domains: user.domains, role: user.role }).then((rows) => ({ ok: true as const, rows }), (e: Error) => ({ ok: false as const, error: e.message }))
    : { ok: false as const, error: src ? 'the Software reader is not registered in this process (monitoring-sources.ts at boot)' : SOURCES_MISSING };
  const rows = listed.ok ? listed.rows.filter((r) => inScope(r, user)) : [];
  const runners = [...new Set(rows.map((r) => r.runner).filter((x): x is string => !!x))];
  const ns = config.softwareRunnerNamespace;
  const logsql = runners.length ? appLogQuery(ns, runners) : null;

  const [podRes, logRes] = await Promise.all([
    runners.length ? k8s('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(POD_SELECTOR)}`) : Promise.resolve(null),
    logsql ? logsQuery(logsql) : Promise.resolve(null),
  ]);

  // Pods: only the asked runners'; the cluster's other pods in the namespace are dropped.
  let podsState: SourceState = live;
  const podsByRunner = new Map<string, (PodFacts & { state: PodState })[]>();
  if (podRes) {
    if (podRes.status === 200) {
      const asked = new Set(runners);
      for (const p of ((podRes.body.items as Record<string, unknown>[]) ?? [])) {
        const f = podFactsOf(p);
        const label = ((p.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {})['app.kubernetes.io/name'];
        const runner = label && asked.has(label) ? label : runnerOfPod(f.name, asked);
        if (!runner) continue;
        (podsByRunner.get(runner) ?? podsByRunner.set(runner, []).get(runner)!).push({ ...f, state: podStateOf(f) });
      }
    } else {
      podsState = unavailable(podRes.status === 0 ? 'Kubernetes API: not reachable from os-ui' : `Kubernetes API answered HTTP ${podRes.status} for the pod list`);
    }
  }
  const logsState: SourceState = !logRes ? live : logRes.ok ? live : unavailable(`VictoriaLogs: ${logRes.detail}`);
  const logCounts = logRes && logRes.ok ? foldAppLogs(logRes.value, runners) : null;

  const apps: SoftwareApp[] = rows.map((r) => {
    const items = r.runner ? podsByRunner.get(r.runner) ?? [] : null;
    const pods: AppPods | null = !r.runner ? null : podsState.state !== 'live' ? null : { state: items!.length ? worstPodState(items!.map((i) => i.state)) : 'no_pods', items: items! };
    return {
      id: r.id, name: r.name, domain: r.domain, scope: r.scope, serveMode: r.serveMode, status: r.status,
      softwareUrl: `/software?focus=${encodeURIComponent(r.id)}`,
      review: r.review ? { requestedAt: r.review.requestedAt, decision: r.review.decision, decidedAt: r.review.decidedAt } : null,
      scan: r.review ? scanOf(r.review.scan) : null,
      pods,
      logs: r.runner && logCounts ? logCounts.get(r.runner) ?? { lines: 0, errors: 0, errorRate: null } : null,
    };
  });
  apps.sort((a, b) => attention(b) - attention(a) || a.name.localeCompare(b.name));

  return {
    view: 'software',
    generatedAt: new Date(nowMs).toISOString(),
    sources: { inventory: listed.ok ? live : unavailable(`software: ${listed.error}`), pods: podsState, logs: logsState },
    summary: listed.ok
      ? {
          apps: apps.length,
          serving: apps.filter((a) => a.status.servedUrl !== null).length,
          scanFailed: apps.filter((a) => a.scan?.verdict === 'failed').length,
          noVerdict: apps.filter((a) => a.scan?.verdict === 'no_verdict').length,
          podsUnhealthy: apps.filter((a) => a.pods && ['crash_looping', 'image_pull_failed', 'failed', 'not_ready'].includes(a.pods.state)).length,
        }
      : null,
    apps,
    queries: { namespace: ns, podSelector: POD_SELECTOR, logsql },
    notUpstream: NOT_UPSTREAM,
  };
}
