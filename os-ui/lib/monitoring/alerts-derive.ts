/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Pure (no IO, no server-only) operational-alert derivation from real in-process
 * signals. Kept free of `server-only` so the logic is unit-testable. `aggregate.ts`
 * feeds in the live signals (governed-run ring + governance cost store).
 *
 * Sources:
 *   1. Failed / denied agent runs from the in-process governed-run ring.
 *   2. Cost-cap breaches (≥100% → critical) or near-breaches (≥90% → warning)
 *      from the governance cost store — caps the admin SET, never mocked.
 *
 * If neither source has any signals, returns [] (honest "no active alerts").
 */
import type { Alert, Scope } from './types';
import { filterScope } from './scope-core';

/** Minimal run record the alert engine needs (subset of agent-governed TraceRecord). */
export type AlertTraceInput = {
  id: string;
  principal: string;
  tool: string;
  decision?: string;
  output: unknown;
};

/** Minimal cap record the alert engine needs (subset of governance/cost Cap + spend). */
export type AlertCapInput = {
  id: string;
  scope: 'key' | 'domain' | 'tenant';
  subject: string;
  limit: number;
  period: string;
  modelClass?: string;
  createdBy: string;
  /** Current accumulated spend for this cap (0 when LiteLLM is offline). */
  spent: number;
};

function traceOutputStr(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(output ?? '');
}

function isFailedTrace(t: AlertTraceInput): boolean {
  return t.decision === 'deny' || /error|fail|aborted/i.test(traceOutputStr(t.output));
}

/** Map a principal to its alert domain (best-effort from principal name). */
function alertDomain(principal: string): string {
  const p = principal.toLowerCase();
  if (p.includes('sales')) return 'sales';
  if (p.includes('finance')) return 'finance';
  return principal || 'unknown';
}

/**
 * Derive operational alerts from real in-process signals. Scope-filtered so
 * users only see alerts for their own principal/domain (same spine as every lens).
 */
export function deriveAlerts(
  traces: AlertTraceInput[],
  caps: AlertCapInput[],
  scope: Scope,
): Alert[] {
  const alerts: Alert[] = [];

  // 1) Failed / denied agent runs (capped at 5 to avoid alert storms).
  const failed = traces.filter(isFailedTrace).slice(0, 5);
  for (const t of failed) {
    const domain = alertDomain(t.principal);
    alerts.push({
      id: `al-run-${t.id}`,
      severity: t.decision === 'deny' ? 'warning' : 'critical',
      title: `Agent run ${t.decision === 'deny' ? 'blocked' : 'failed'}: ${t.tool}`,
      detail: `Run ${t.id} by ${t.principal}${t.decision === 'deny' ? ' — governance denied.' : ' — see run trace for errors.'}`,
      domain,
      owner: t.principal,
      disposition: 'notified',
      links: { runId: t.id },
      source: 'live',
    });
  }

  // 2) Cost-cap breaches / near-breaches from the governance cost store.
  for (const c of caps) {
    if (c.limit <= 0 || c.spent <= 0) continue; // no spend yet → no alert
    const ratio = c.spent / c.limit;
    if (ratio < 0.9) continue;
    const domain = c.scope === 'domain' ? c.subject : 'platform';
    const over = ratio >= 1;
    alerts.push({
      id: `al-cap-${over ? 'over' : 'warn'}-${c.id}`,
      severity: over ? 'critical' : 'warning',
      title: `Cost cap ${over ? 'breached' : 'nearing'}: ${c.subject} (${c.scope})`,
      detail: `$${c.spent.toFixed(0)} of $${c.limit} ${c.period} Governance cap (${Math.round(ratio * 100)}%).`,
      domain,
      owner: c.createdBy,
      disposition: 'notified',
      links: { capRef: c.id },
      source: 'live',
    });
  }

  return filterScope(scope, alerts);
}
