/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { LineageEdge } from '@/lib/files/lineage';
import type { FileAsset } from '@/lib/files/asset-schema';

/**
 * OpenMetadata catalog + lineage push (LIVE-or-mock). The authoritative record is
 * always the in-process `lib/files/lineage.ts` ring (mock-tolerant); this module
 * is the BEST-EFFORT mirror to a real OpenMetadata when one is reachable — exactly
 * the dual pattern the rest of the stack uses (Langfuse trace, approvals
 * write-through). OM is OFF by default locally (~2.5 GB JVM), so every call here
 * is wrapped in a short timeout and swallows failure: kind never blocks on it.
 *
 * server-only: it talks to the OM REST API, so it is imported by routes, not by
 * the pure store/tests.
 */

async function omFetch(path: string, init: RequestInit, ms = 2000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${config.openmetadataApiUrl}${path}`, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null; // OM unreachable (the kind default) — the in-process ring is the record
  } finally {
    clearTimeout(timer);
  }
}

/** Mirror one lineage edge to OM (best-effort). Returns whether it landed. */
export async function pushLineage(edge: LineageEdge): Promise<boolean> {
  const res = await omFetch('/api/v1/lineage', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      edge: {
        fromEntity: { id: edge.fileId, type: 'container', name: edge.fileName },
        toEntity: { fqn: edge.target, type: 'container' },
        lineageDetails: { description: `${edge.kind} by ${edge.by} at ${edge.at}` },
      },
    }),
  });
  return Boolean(res && res.ok);
}

/** Catalog (register) a file as an OM container asset (best-effort). */
export async function catalogFile(a: FileAsset): Promise<boolean> {
  const res = await omFetch('/api/v1/containers', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: a.id,
      displayName: a.name,
      description: a.description,
      fileFormats: [a.kind],
      tags: a.tags.map((t) => ({ tagFQN: `Files.${t}` })),
      sourceUrl: a.deepLink,
    }),
  });
  return Boolean(res && res.ok);
}
