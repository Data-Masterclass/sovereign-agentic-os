/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';

/**
 * Strategy audit trail. Every pillar/target edit is recorded as a Langfuse trace
 * (the same audit substrate the governed data tools use — see `lib/governed.ts`),
 * so it appears in Monitoring/Langfuse alongside agent + tool activity. This is
 * best-effort + offline-safe: when Langfuse is unreachable (the local-`kind`
 * default) we keep an in-process ring buffer so the teaching flow still shows an
 * audit feed, and the call never blocks or throws.
 */

export type StrategyAuditAction =
  | 'pillar.create'
  | 'pillar.update'
  | 'pillar.delete'
  | 'pillar.link-bet'
  | 'pillar.unlink-bet'
  | 'targets.set'
  | 'headline-target.set'
  | 'value-metric.set'
  | 'value-entry.add'
  | 'actuals.snapshot';

export type StrategyAuditEvent = {
  action: StrategyAuditAction;
  actor: string;
  domain: string;
  pillarId: string;
  pillarName?: string;
  detail?: Record<string, unknown>;
  at: string;
};

const RING: StrategyAuditEvent[] = [];
const RING_MAX = 200;

async function withTimeout(url: string, init: RequestInit, ms = 2000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Record a Strategy edit. Returns whether the Langfuse trace landed. */
export async function auditStrategy(
  event: Omit<StrategyAuditEvent, 'at'>,
): Promise<{ landed: boolean }> {
  const full: StrategyAuditEvent = { ...event, at: new Date().toISOString() };
  RING.push(full);
  if (RING.length > RING_MAX) RING.shift();

  const id = `os-strategy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const auth =
    'Basic ' +
    Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const body = {
    batch: [
      {
        id,
        type: 'trace-create',
        timestamp: full.at,
        body: {
          id,
          name: `strategy.${event.action}`,
          metadata: { actor: event.actor, domain: event.domain, pillarId: event.pillarId },
          input: { pillar: event.pillarName, detail: event.detail ?? {} },
          output: { ok: true },
          tags: ['strategy-golden-path', `action:${event.action}`, `domain:${event.domain}`],
        },
      },
    ],
  };
  const res = await withTimeout(`${config.langfuseUrl}/api/public/ingestion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });
  return { landed: Boolean(res && res.ok) };
}

/** Recent in-process audit events (newest first) — the offline audit feed. */
export function recentStrategyAudit(pillarId?: string, limit = 50): StrategyAuditEvent[] {
  const items = pillarId ? RING.filter((e) => e.pillarId === pillarId) : RING;
  return [...items].reverse().slice(0, limit);
}
