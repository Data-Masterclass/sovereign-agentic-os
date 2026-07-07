/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { osMirror } from './os-mirror.ts';

/**
 * The ONE reusable version-history helper every artifact store shares (agent
 * systems, apps, big bets, dashboards, knowledge docs, files, generic
 * artifacts). It is the generalization of lib/strategy/snapshots.ts: an
 * append-only log of immutable snapshots, one durable mirror per artifact
 * family, an authoritative in-process cache so history survives with NO live
 * cluster, and best-effort write-through so it also survives a redeploy.
 *
 * A store captures the PRIOR state of an artifact right before it mutates it,
 * so the log holds every superseded version. RESTORE is orchestrated by the
 * store: it reads a version's `state`, snapshots the CURRENT live state as a
 * fresh version first (restore is itself auditable + reversible), then applies
 * the chosen version. The helper is deliberately state-agnostic — each store
 * decides what JSON to snapshot and how to apply it — so it never grows
 * store-specific knowledge.
 *
 * Kept free of `server-only`/Next imports (only `os-mirror`) so it is directly
 * unit-testable; the API routes remain the server boundary that authenticates.
 */

export type ArtifactVersion = {
  /** Artifact family, e.g. `agent-system`, `dashboard`, `big-bet`. */
  kind: string;
  artifactId: string;
  /** 1-based, monotonically increasing per artifact. */
  version: number;
  /** ISO timestamp the snapshot was captured. */
  at: string;
  /** User id that caused the snapshot (or `system` for automated captures). */
  author: string;
  /** Short human label, e.g. `edit`, `restore of v3`, `archive`. */
  summary: string;
  /** Opaque JSON snapshot of the artifact at capture time (store-defined). */
  state: unknown;
};

export type VersionLog = {
  readonly kind: string;
  ensureHydrated(): Promise<void>;
  /** Append a snapshot of `state` as the next version. Returns the record. */
  record(artifactId: string, author: string, state: unknown, summary?: string): ArtifactVersion;
  /** Every version for an artifact, NEWEST first (empty when none). */
  list(artifactId: string): ArtifactVersion[];
  /** One version by number, or undefined. */
  get(artifactId: string, version: number): ArtifactVersion | undefined;
  /** Highest version number captured (0 when none). */
  latest(artifactId: string): number;
  /** Forget + delete-through every version of an artifact (on hard delete). */
  purge(artifactId: string): void;
  /** Test seam: forget all history. */
  __reset(): void;
};

function now(): string {
  return new Date().toISOString();
}

type LogState = { store: Map<string, ArtifactVersion[]>; hydration: Promise<void> | null };

/**
 * A version log for one artifact family. Give each family a distinct `kind`;
 * the durable mirror lives in its own `os-versions-<kind>` index so hydration
 * stays scoped to that family (same discipline as the per-store mirrors).
 */
export function versionLog(kind: string): VersionLog {
  const STATE_KEY = Symbol.for(`soa.versions.${kind}`);
  function logState(): LogState {
    const g = globalThis as unknown as Record<symbol, LogState | undefined>;
    if (!g[STATE_KEY]) g[STATE_KEY] = { store: new Map(), hydration: null };
    return g[STATE_KEY]!;
  }

  const mirror = osMirror({
    index: `os-versions-${kind}`,
    createBody: {
      mappings: {
        properties: {
          kind: { type: 'keyword' },
          artifactId: { type: 'keyword' },
          version: { type: 'integer' },
          at: { type: 'date' },
          author: { type: 'keyword' },
          summary: { type: 'text' },
          // Opaque snapshot — never indexed, only stored + returned verbatim.
          state: { type: 'object', enabled: false },
        },
      },
    },
  });

  const docId = (artifactId: string, version: number) => `${artifactId}:${version}`;

  function versionsFor(artifactId: string): ArtifactVersion[] {
    return logState().store.get(artifactId) ?? [];
  }

  async function hydrate(): Promise<void> {
    const s = logState();
    const docs = (await mirror.hydrate(5000)) ?? [];
    for (const v of docs as ArtifactVersion[]) {
      if (!v || !v.artifactId || typeof v.version !== 'number') continue;
      const list = s.store.get(v.artifactId) ?? [];
      if (!list.some((x) => x.version === v.version)) list.push(v);
      s.store.set(v.artifactId, list);
    }
    for (const list of s.store.values()) list.sort((a, b) => a.version - b.version);
  }

  return {
    kind,
    ensureHydrated() {
      const s = logState();
      if (!s.hydration) s.hydration = hydrate();
      return s.hydration;
    },
    record(artifactId, author, state, summary) {
      const list = versionsFor(artifactId);
      const version = (list[list.length - 1]?.version ?? 0) + 1;
      const v: ArtifactVersion = {
        kind,
        artifactId,
        version,
        at: now(),
        author,
        summary: summary?.trim() || 'edit',
        // Deep clone so later mutation of the live record can't rewrite history.
        state: structuredClone(state),
      };
      list.push(v);
      logState().store.set(artifactId, list);
      mirror.writeThrough(docId(artifactId, version), v);
      return v;
    },
    list(artifactId) {
      return [...versionsFor(artifactId)].sort((a, b) => b.version - a.version);
    },
    get(artifactId, version) {
      return versionsFor(artifactId).find((v) => v.version === version);
    },
    latest(artifactId) {
      const list = versionsFor(artifactId);
      return list[list.length - 1]?.version ?? 0;
    },
    purge(artifactId) {
      const list = versionsFor(artifactId);
      for (const v of list) mirror.deleteThrough(docId(artifactId, v.version));
      logState().store.delete(artifactId);
    },
    __reset() {
      const s = logState();
      s.store.clear();
      s.hydration = null;
      mirror.__reset();
    },
  };
}
