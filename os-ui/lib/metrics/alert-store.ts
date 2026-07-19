/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '../infra/os-mirror.ts';
import type { AlertRule } from './alerts.ts';

/**
 * Durable alert-rule registry — mirrors the dashboards store pattern (osMirror
 * write-through + global-symbol in-process cache). Alert rules are owned by a user,
 * evaluated by the /api/metrics/alerts/run endpoint (wire to a CronJob — see chart
 * follow-up note below), and stored in the os-alert-rules OpenSearch index.
 *
 * Chart follow-up: wire the /api/metrics/alerts/run endpoint to a Kubernetes CronJob
 * (charts/sovereign-agentic-os/templates/metrics-alert-cronjob.yaml) on a schedule
 * like `* /5 * * * *` (every 5 minutes) to auto-evaluate all persisted rules.
 */

export type AlertRuleRecord = AlertRule & {
  owner: string;
  domain: string;
  createdAt: string;
  lastEvaluated?: string;
  lastBreached?: boolean;
  lastValue?: number;
};

const ALERT_STORE_KEY = Symbol.for('soa.metrics.alert-rules.store');

type AlertStoreState = { rules: Map<string, AlertRuleRecord>; hydration: Promise<void> | null };

function alertStoreState(): AlertStoreState {
  const g = globalThis as unknown as Record<symbol, AlertStoreState | undefined>;
  if (!g[ALERT_STORE_KEY]) g[ALERT_STORE_KEY] = { rules: new Map(), hydration: null };
  return g[ALERT_STORE_KEY]!;
}

const mirror = osMirror({
  index: 'os-alert-rules',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        member: { type: 'keyword' },
        comparator: { type: 'keyword' },
        threshold: { type: 'double' },
        createdAt: { type: 'date' },
        lastEvaluated: { type: 'date' },
        lastBreached: { type: 'boolean' },
        lastValue: { type: 'double' },
      },
    },
  },
});

export async function ensureHydrated(): Promise<void> {
  const s = alertStoreState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = alertStoreState();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const rec of docs as AlertRuleRecord[]) {
    if (rec.id) s.rules.set(rec.id, rec);
  }
}

export function saveAlertRule(rule: AlertRule, owner: string, domain = 'default'): AlertRuleRecord {
  const s = alertStoreState();
  const existing = s.rules.get(rule.id);
  const rec: AlertRuleRecord = {
    ...rule,
    owner,
    domain,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(existing?.lastEvaluated ? { lastEvaluated: existing.lastEvaluated } : {}),
    ...(existing?.lastBreached !== undefined ? { lastBreached: existing.lastBreached } : {}),
    ...(existing?.lastValue !== undefined ? { lastValue: existing.lastValue } : {}),
  };
  s.rules.set(rec.id, rec);
  mirror.writeThrough(rec.id, rec);
  return rec;
}

export function getAlertRule(id: string): AlertRuleRecord | null {
  return alertStoreState().rules.get(id) ?? null;
}

export function listAlertRules(owner?: string): AlertRuleRecord[] {
  const rules = Array.from(alertStoreState().rules.values());
  if (!owner) return rules;
  return rules.filter((r) => r.owner === owner);
}

export function deleteAlertRule(id: string, owner: string): boolean {
  const s = alertStoreState();
  const rec = s.rules.get(id);
  if (!rec || rec.owner !== owner) return false;
  s.rules.delete(id);
  // Best-effort mirror removal (osMirror does not expose delete; set archived flag)
  mirror.writeThrough(id, { ...rec, _deleted: true });
  return true;
}

export function recordEvaluation(id: string, value: number, breached: boolean): AlertRuleRecord | null {
  const s = alertStoreState();
  const rec = s.rules.get(id);
  if (!rec) return null;
  const updated: AlertRuleRecord = {
    ...rec,
    lastEvaluated: new Date().toISOString(),
    lastValue: value,
    lastBreached: breached,
  };
  s.rules.set(id, updated);
  mirror.writeThrough(id, updated);
  return updated;
}

/** For tests only — reset in-process state without touching the mirror. */
export function __resetAlertStore(): void {
  const g = globalThis as unknown as Record<symbol, AlertStoreState | undefined>;
  g[ALERT_STORE_KEY] = { rules: new Map(), hydration: null };
}
