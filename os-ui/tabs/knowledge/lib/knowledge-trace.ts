/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { recordObservation } from '@core/infra/langfuse';

/**
 * What entered an agent's context window for a knowledge query: the PINNED items
 * (domain card + workflow steps + hard rules) vs the RETRIEVED tail, plus the tokens
 * and the governance decision. One Langfuse `retriever` observation through the one
 * writer (`core/infra/langfuse.ts`) — nested in the active trace when there is one —
 * plus an in-process ring so the view is inspectable with no live Langfuse.
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

export async function traceContext(event: ContextTraceEvent): Promise<ContextTraceRecord> {
  const id = `os-knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  const landed = recordObservation({
    name: 'knowledge.context_pack',
    asType: 'retriever',
    input: { query: event.query },
    output: { pinned: event.pinned, retrieved: event.retrieved },
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
    tags: ['knowledge-context-layer', `decision:${event.decision}`, `store:${event.store}`],
  });
  const rec: ContextTraceRecord = { ...event, id, timestamp, landed };
  RING.push(rec);
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX);
  return rec;
}
