/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Personal agent systems live in the owner's user repository, not in the domain's
 * USER STORY: As a creator I want my personal (My-scope) agent systems in MY repository
 *             (`user-<token>`), readable by me and the admins only, so the domain's members see
 *             what the domain shares and nothing that is still mine (component design 12).
 * ARCHITECTURE:
 *   - PURE split + render. A domain repo in the v2 layout (`os/layout.yml`) carries only its
 *     domain-scope systems under `agents/`; each owner's personal systems, across every domain, are
 *     rendered with the SAME generator into the owner's user repo under `agents/<system>/` — the
 *     same shape as a domain repo. A v1 domain repo is unchanged (the legacy personal lane).
 *   - The generator places a personal system under the legacy lane `agents/personal/<token>/`;
 *     this module re-roots that lane at `agents/` (paths AND the generated text that names them),
 *     which is a deterministic string map, so regeneration stays byte-stable.
 *   - Every repo name and path comes from `core/infra/repo-layout.ts`.
 */
import { generateAgentFiles, placeSystems } from '@tabs/agents/lib/git/generate';
import type { AgentProjectSnapshot, SnapshotSystem } from '@tabs/agents/lib/git/snapshot';
import { AGENTS_DIR, legacyPersonalAgentLane, prefixOf, principalToken, userRepoName } from '@core/infra/repo-layout';

export function isPersonal(s: SnapshotSystem): boolean {
  return s.visibility === 'Personal';
}

/** The domain-scope half of a snapshot (what a v2 domain repo carries). */
export function domainScopeSnapshot(snapshot: AgentProjectSnapshot): AgentProjectSnapshot {
  return { domain: snapshot.domain, systems: snapshot.systems.filter((s) => !isPersonal(s)) };
}

/** The owners with a personal system in the snapshot. Sorted. */
export function personalOwners(snapshot: AgentProjectSnapshot): string[] {
  return [...new Set(snapshot.systems.filter(isPersonal).map((s) => s.owner))].sort();
}

/** Re-root one owner's legacy lane at `agents/`: paths and the text the generator wrote. */
export function rerootPersonal(files: Map<string, string>, owner: string): Map<string, string> {
  const lane = legacyPersonalAgentLane(owner);
  const root = prefixOf(AGENTS_DIR);
  const out = new Map<string, string>();
  for (const [p, c] of files) {
    const path = p.startsWith(lane) ? `${root}${p.slice(lane.length)}` : p;
    out.set(path, c.split(lane).join(root).split(lane.slice(0, -1)).join(AGENTS_DIR));
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The `agents/` subtree of one owner's user repo, from that owner's personal systems in every
 * domain (`systems` is the union; other owners' systems are ignored). `domain` in the index is
 * the user repo's name — this repo is not any one domain's.
 */
export function userRepoAgentFiles(owner: string, systems: readonly SnapshotSystem[]): Map<string, string> {
  const mine = systems.filter((s) => isPersonal(s) && s.owner === owner);
  const snapshot: AgentProjectSnapshot = { domain: userRepoName(owner), systems: [...mine].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  return rerootPersonal(generateAgentFiles(snapshot), owner);
}

/** Where a personal system's folder is in its owner's user repo (`agents/<slug>/`), or null. */
export function userRepoSystemDir(owner: string, systems: readonly SnapshotSystem[], systemId: string): string | null {
  const mine = systems.filter((s) => isPersonal(s) && s.owner === owner);
  const placed = placeSystems({ domain: userRepoName(owner), systems: mine }).find((p) => p.system.id === systemId);
  if (!placed) return null;
  const lane = legacyPersonalAgentLane(owner);
  const dir = `${placed.dir}/`;
  return dir.startsWith(lane) ? `${prefixOf(AGENTS_DIR)}${dir.slice(lane.length)}` : dir;
}

export { principalToken, userRepoName };
