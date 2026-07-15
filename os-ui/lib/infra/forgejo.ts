/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Forgejo (Gitea-compatible) client contract — the external git-service boundary
 * shared across the OS (agent systems, software apps, and the git-backed version
 * history helper). It lives in `lib/infra` because Forgejo is an EXTERNAL service:
 * per the layer contract, core/infra must never import upward from a tab, so the
 * shape every tab and core helper depends on belongs here, not inside a tab.
 *
 * These are PURE type declarations (no runtime, no `server-only`/Next import) so
 * they stay unit-testable against in-memory fakes; the real fetch-backed clients
 * live in each tab's `live-clients.ts` (server boundary) and implement this shape.
 */

/** One commit in a repo's history (Gitea/Forgejo commits API), newest first. */
export type ForgejoCommit = { sha: string; message: string; author: string; date: string };
/** A path→content map of a repo's whitelisted files AT a given commit. */
export type ForgejoCommitFiles = Record<string, string>;

export interface ForgejoClient {
  ensureRepo(repo: string): Promise<void>;
  readFile(repo: string, path: string): Promise<{ content: string; sha: string } | null>;
  writeFile(repo: string, path: string, content: string, sha?: string, message?: string): Promise<{ sha: string }>;
  /** PHYSICALLY delete the system's repo (DELETE path only). Returns whether the
   *  repo is gone; throws only on a real failure (unreachable / rejected) so the
   *  caller reports an orphan honestly. A missing repo (404) resolves cleanly. */
  deleteRepo(repo: string): Promise<{ deleted: boolean }>;
  /** The repo's commit history on `main`, NEWEST first. Returns `null` when the
   *  repo has no git history yet OR Forgejo is unreachable, so the caller can fall
   *  back to snapshot versioning honestly rather than fabricate an empty history. */
  listCommits(repo: string, opts?: { limit?: number }): Promise<ForgejoCommit[] | null>;
  /** The system's whitelisted files (system.yaml + agents/*) AS THEY WERE at `sha`,
   *  read via the contents-at-ref API. Returns `null` when unreachable so restore
   *  fails loudly rather than clobbering HEAD with empty content. */
  getCommitFiles(repo: string, sha: string): Promise<ForgejoCommitFiles | null>;
}
