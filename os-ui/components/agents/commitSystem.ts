/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { serializeSystem, type System } from '@/lib/agents/system-schema';

/**
 * Commit a mutated {@link System} back to the one source (system.yaml) through the
 * same whitelisted, sha-checked file write the Monaco panel + agent-system chat
 * use. Reads the current sha first for optimistic concurrency, then PUTs. Throws
 * with the route's error message on failure (incl. a 409 stale-sha conflict).
 */
export async function commitSystem(systemId: string, next: System): Promise<void> {
  const cur = await fetch(`/api/agents/systems/${systemId}/files?path=system.yaml`, { cache: 'no-store' });
  const curBody = await cur.json();
  if (!cur.ok) throw new Error(curBody.error ?? 'Could not read system.yaml');
  const res = await fetch(`/api/agents/systems/${systemId}/files`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'system.yaml', content: serializeSystem(next), sha: curBody.sha }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Save failed');
}
