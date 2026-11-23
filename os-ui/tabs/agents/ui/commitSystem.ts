/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { serializeSystem, type System } from '@tabs/agents/lib/system-schema';

/**
 * Commit a mutated {@link System} back to the one source (system.yaml) through the
 * same whitelisted, sha-checked file write the Monaco panel + agent-system chat
 * use. Reads the current sha first for optimistic concurrency, then PUTs. Throws
 * with the route's error message on failure (incl. a 409 stale-sha conflict).
 */
/** Returns the folder warnings of the save: folders the definition names that could not be created. */
export async function commitSystem(systemId: string, next: System): Promise<string[]> {
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
  return ((body as { folders?: { warnings?: { message: string }[] } }).folders?.warnings ?? []).map((w) => w.message);
}
