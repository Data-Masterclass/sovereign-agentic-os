/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';

/**
 * Langfuse trace of what entered an agent's context window for a knowledge query:
 * the PINNED items (domain card + workflow steps + hard rules) vs the RETRIEVED
 * tail, plus the tokens and the governance decision. Best-effort POST to Langfuse
 * + an in-process ring buffer so the pinned-vs-retrieved view is inspectable even
 * with no live Langfuse (kind). Mirrors `lib/agent-governed.ts` trace().
 */

export type ContextTraceEvent = {
  principal: string;
  query: string;
  workflowId: string | null;
  pinned: { id: string; kind: string; title: string }[];
  retrieved: { id: string; title: string; score: number }[];
  dropped: number;
  totalTokens: number;
  budget: number;
  decision: 'allow' | 'deny';
  policy: string;
  embedSource: string;
  store: string;
};

export type ContextTraceRecord = ContextTraceEvent & { id: string; timestamp: string; landed: boolean };

const RING: ContextTraceRecord[] = [];
const RING_MAX = 100;

export function recentContextTraces(limit = 25): ContextTraceRecord[] {
  return RING.slice(-limit).reverse();
}

async function withTimeout(url: string, init: RequestInit, ms = 2500): Promise<Response | null> {
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

export async function traceContext(event: ContextTraceEvent): Promise<ContextTraceRecord> {
  const id = `os-knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  const auth =
    'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const body = {
    batch: [
      {
        id,
        type: 'trace-create',
        timestamp,
        body: {
          id,
          name: 'knowledge.context_pack',
          metadata: {
            principal: event.principal,
            workflowId: event.workflowId,
            pinnedCount: event.pinned.length,
            retrievedCount: event.retrieved.length,
            dropped: event.dropped,
            totalTokens: event.totalTokens,
            budget: event.budget,
            decision: event.decision,
            policy: event.policy,
            embedSource: event.embedSource,
            store: event.store,
          },
          input: { query: event.query },
          output: { pinned: event.pinned, retrieved: event.retrieved },
          tags: ['knowledge-context-layer', `decision:${event.decision}`, `store:${event.store}`],
        },
      },
    ],
  };
  const res = await withTimeout(`${config.langfuseUrl}/api/public/ingestion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });
  const rec: ContextTraceRecord = { ...event, id, timestamp, landed: Boolean(res && res.ok) };
  RING.push(rec);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
  return rec;
}
