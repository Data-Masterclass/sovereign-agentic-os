/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Durable alert-rule store for metric alerts
 * USER STORY: As a creator I want my metric alert rules to survive a restart and keep their last
 *             evaluation, so that the scheduled check can keep evaluating them.
 * ARCHITECTURE:
 *   - Server-only. In-process map keyed by `Symbol.for` with write-through to the `os-alert-rules`
 *     OpenSearch index via `osMirror`, the same pattern as the dashboards store.
 *   - Hydrated on demand; legacy `email`/`slack` channels are coerced to `in_app` on load.
 *   - Used by `app/api/metrics/alerts/route.ts` and `app/api/metrics/alerts/run/route.ts`; the run
 *     route is called on a schedule by the chart's `extensions/metrics/metrics-alert-cronjob.yaml`.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { coerceChannels, type AlertRule } from '@tabs/metrics/lib/alerts';

export type AlertRuleRecord = AlertRule & {
  owner: string;
  domain: string;
  createdAt: string;
  lastEvaluated?: string;
  lastBreached?: boolean;
  lastValue?: number;
};

const ALERT_STORE_KEY = Symbol.for('soa.metrics.alert-rules.store');

type AlertStoreState = { rules: Map<string, AlertRuleRecord>; hydration: Promise<void> | null; hydratedAt?: number; hydrateFailedAt?: number };

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

/**
 * Did the rules really LOAD? An unreachable mirror leaves the map empty, which is indistinguishable from
 * "no rules" — a reader that shows a count must ask this first (the dashboards store's `hydrationState`).
 */
export function alertStoreHydrationState(): 'hydrated' | 'failed' | 'pending' {
  const s = alertStoreState();
  if (s.hydratedAt !== undefined) return 'hydrated';
  return s.hydrateFailedAt !== undefined ? 'failed' : 'pending';
}

async function hydrate(): Promise<void> {
  const s = alertStoreState();
  const docs = await mirror.hydrate(1000);
  if (docs === null) {
    // The mirror could not be read: stay un-hydrated and say so, so the next read retries and no reader
    // mistakes the empty map for "no rules". A failed hydration is never cached as done.
    s.hydrateFailedAt = Date.now();
    s.hydration = null;
    return;
  }
  for (const rec of docs as AlertRuleRecord[]) {
    // Coerce legacy 'email'/'slack' channels to the only supported one ('in_app') so old
    // persisted rules keep firing — never crash on legacy data.
    if (rec.id) s.rules.set(rec.id, { ...rec, notify: coerceChannels(rec.notify) });
  }
  s.hydratedAt = Date.now();
  delete s.hydrateFailedAt;
}

export function saveAlertRule(rule: AlertRule, owner: string, domain = 'default'): AlertRuleRecord {
  const s = alertStoreState();
  const existing = s.rules.get(rule.id);
  const rec: AlertRuleRecord = {
    ...rule,
    notify: coerceChannels(rule.notify),
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

export function listAlertRules(owner?: string): AlertRuleRecord[] {
  const rules = Array.from(alertStoreState().rules.values());
  if (!owner) return rules;
  return rules.filter((r) => r.owner === owner);
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
  mirror.__reset();
}
