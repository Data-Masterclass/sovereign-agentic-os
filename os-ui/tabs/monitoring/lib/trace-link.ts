/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Langfuse trace link of one Monitoring run row
 * ARCHITECTURE:
 *   - `base` is `config.langfuseConsoleUrl` (LANGFUSE_CONSOLE_URL) and nothing else: the chart
 *     derives it from the same `ingress.hosts.langfuse` its Langfuse route serves, and renders it
 *     empty when Langfuse has no browser route — so there is no second copy of the host here.
 *   - Only a run read FROM Langfuse (`source: 'live'`) has a Langfuse trace id; an in-process
 *     ring record does not, and gets no link rather than a link to a not-found page.
 *   - `/trace/<id>` is the same path `core/infra/langfuse.ts` `traceUrlFor` links to.
 */
export function runTraceLink(base: string, run: { id: string; source: string }): string | undefined {
  const root = String(base ?? '').replace(/\/+$/, '');
  if (!root || !run.id || run.source !== 'live') return undefined;
  return `${root}/trace/${encodeURIComponent(run.id)}`;
}
