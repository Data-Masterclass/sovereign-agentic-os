/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { serializeWorkflow, type Workflow } from '@/lib/knowledge/schema';

/**
 * Commit a mutated {@link Workflow} back to the one source (`workflow.md`) through
 * the same sha-checked PATCH the Monaco panel uses. Clone of agents'
 * `commitSystem`: read the current sha first (optimistic concurrency), then PATCH.
 * Throws the route's error message on failure (incl. a 409 stale-sha conflict), so
 * the swimlane, the markdown editor and the Mermaid preview all edit one source.
 */
export async function commitWorkflow(workflowId: string, next: Workflow): Promise<void> {
  const cur = await fetch(`/api/knowledge/workflows/${workflowId}`, { cache: 'no-store' });
  const curBody = await cur.json();
  if (!cur.ok) throw new Error(curBody.error ?? 'Could not read workflow');
  const res = await fetch(`/api/knowledge/workflows/${workflowId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ md: serializeWorkflow(next), sha: curBody.sha }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Save failed');
}
