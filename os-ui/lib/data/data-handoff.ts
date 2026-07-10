/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * One connection, used TWO ways (Connections golden path "one object, two
 * usages"). The SAME governed connection is both an AGENT TOOL (governed tool
 * calls, `lib/connections.ts`) and a DATA SOURCE:
 *   • Database/API/SaaS → ingested into the lake via dlt → BRONZE (Data tab), and
 *   • Drive            → synced/indexed into FILES.
 * Same creds, same governance; only the usage differs. This is the mock handoff
 * that proves it in kind: registering a Postgres connection as a Bronze source
 * does NOT stop it also being a `query` tool. The real handoff is `lib/data`
 * (dlt → Bronze) and `lib/files` (Drive → Files); this in-process registry stands
 * in until those land, with the same record shape.
 */

export type DataUsage = 'bronze' | 'files';

export type BronzeSource = {
  id: string;
  connectionId: string;
  name: string;
  connector: string;
  /** The Bronze table the connection lands in (Iceberg). */
  table: string;
  rows: number;
  registeredBy: string;
  registeredAt: string;
};

export type FilesIndex = {
  id: string;
  connectionId: string;
  name: string;
  items: number;
  indexedBy: string;
  indexedAt: string;
};

type HandoffState = { bronze: Map<string, BronzeSource>; files: Map<string, FilesIndex> };
const HANDOFF_KEY = Symbol.for('soa.dataHandoff.state');
function handoff(): HandoffState {
  const g = globalThis as unknown as Record<symbol, HandoffState | undefined>;
  if (!g[HANDOFF_KEY]) g[HANDOFF_KEY] = { bronze: new Map(), files: new Map() };
  return g[HANDOFF_KEY]!;
}

function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'src';
}

/** Register/refresh the connection as a dlt → Bronze source. Returns the record. */
export function registerBronzeSource(input: {
  connectionId: string;
  name: string;
  connector: string;
  rows?: number;
  registeredBy: string;
}): BronzeSource {
  const existing = handoff().bronze.get(input.connectionId);
  const src: BronzeSource = {
    id: existing?.id ?? rid('bronze'),
    connectionId: input.connectionId,
    name: input.name,
    connector: input.connector,
    table: `bronze.${slug(input.name)}`,
    rows: input.rows ?? existing?.rows ?? 0,
    registeredBy: input.registeredBy,
    registeredAt: new Date().toISOString(),
  };
  handoff().bronze.set(input.connectionId, src);
  return src;
}

/** Index a Drive connection into Files. Returns the record. */
export function indexToFiles(input: { connectionId: string; name: string; items?: number; indexedBy: string }): FilesIndex {
  const existing = handoff().files.get(input.connectionId);
  const idx: FilesIndex = {
    id: existing?.id ?? rid('files'),
    connectionId: input.connectionId,
    name: input.name,
    items: input.items ?? existing?.items ?? 0,
    indexedBy: input.indexedBy,
    indexedAt: new Date().toISOString(),
  };
  handoff().files.set(input.connectionId, idx);
  return idx;
}

export function bronzeFor(connectionId: string): BronzeSource | null {
  return handoff().bronze.get(connectionId) ?? null;
}
export function filesFor(connectionId: string): FilesIndex | null {
  return handoff().files.get(connectionId) ?? null;
}
export function listBronzeSources(): BronzeSource[] {
  return [...handoff().bronze.values()];
}
export function _clearHandoffs(): void {
  handoff().bronze.clear();
  handoff().files.clear();
}
