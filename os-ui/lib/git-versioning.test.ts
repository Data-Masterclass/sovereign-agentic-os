/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgejoClient, ForgejoCommit, ForgejoCommitFiles } from './agents/build/live.ts';
import { listGitVersions, restoreGitVersion, shaForVersion, systemRepo } from './git-versioning.ts';

/**
 * Unit tests for the git-backed version helper against a MOCKED ForgejoClient that
 * models a repo as a tip file-set plus an append-only commit log with per-commit
 * snapshots (exactly what Gitea's commits + contents-at-ref APIs expose). No
 * network — the helper's mapping + non-destructive restore are exercised directly.
 */

type FakeRepo = {
  /** Current file tip (path → content). */
  tip: Map<string, string>;
  /** Append-only commit log, newest first. */
  commits: ForgejoCommit[];
  /** Per-commit file snapshot (sha → path→content). */
  snapshots: Map<string, ForgejoCommitFiles>;
};

/** A ForgejoClient backed by an in-memory git-ish repo. `null` repos = unreachable. */
function fakeForgejo(repos: Map<string, FakeRepo>): ForgejoClient {
  let seq = 0;
  const commit = (repo: FakeRepo, message: string, author: string) => {
    const sha = `sha${(++seq).toString().padStart(4, '0')}`;
    repo.commits.unshift({ sha, message, author, date: new Date(1700000000000 + seq * 1000).toISOString() });
    repo.snapshots.set(sha, Object.fromEntries(repo.tip));
    return sha;
  };
  return {
    async ensureRepo() {},
    async readFile(repoName, path) {
      const r = repos.get(repoName);
      if (!r) return null;
      const content = r.tip.get(path);
      return content === undefined ? null : { content, sha: `blob:${path}:${content.length}` };
    },
    async writeFile(repoName, path, content, _sha, message) {
      const r = repos.get(repoName);
      if (!r) throw new Error('unreachable');
      r.tip.set(path, content);
      const sha = commit(r, message ?? `Build: sync ${path}`, 'writer');
      return { sha: `blob:${path}:${content.length}:${sha}` };
    },
    async deleteRepo() {
      return { deleted: true };
    },
    async listCommits(repoName, opts) {
      const r = repos.get(repoName);
      if (!r) return null; // unreachable / no repo
      return r.commits.slice(0, opts?.limit ?? 30);
    },
    async getCommitFiles(repoName, sha) {
      const r = repos.get(repoName);
      if (!r) return null;
      return r.snapshots.get(sha) ?? null;
    },
  };
}

/** Seed a repo with an initial build (v0 commit) then a couple of edits. */
function seedRepo(): { repos: Map<string, FakeRepo>; repo: string } {
  const repo = systemRepo('sys1');
  const r: FakeRepo = { tip: new Map(), commits: [], snapshots: new Map() };
  const repos = new Map([[repo, r]]);
  const fj = fakeForgejo(repos);
  // Three successive builds (each writeFile = one commit).
  void fj.writeFile(repo, 'system.yaml', 'version: "1"\n# build A', undefined, 'Build A');
  void fj.writeFile(repo, 'agents/assistant/AGENT.md', '# A', undefined, 'Build A');
  void fj.writeFile(repo, 'system.yaml', 'version: "1"\n# build B', undefined, 'Build B');
  void fj.writeFile(repo, 'system.yaml', 'version: "1"\n# build C', undefined, 'Build C');
  return { repos, repo };
}

test('listGitVersions maps commits to the VersionHistory shape, newest first', async () => {
  const { repos, repo } = seedRepo();
  const fj = fakeForgejo(repos);
  const versions = await listGitVersions(fj, repo);
  assert.ok(versions, 'git history present');
  assert.equal(versions![0].version, 0, 'index 0 is HEAD (current)');
  assert.equal(versions![0].summary, 'Build C', 'summary = commit message first line');
  assert.equal(versions![0].author, 'writer');
  assert.ok(versions![0].at, 'has an ISO date');
  // Monotonic increasing index; distinct messages preserved in order.
  assert.deepEqual(versions!.map((v) => v.version), [0, 1, 2, 3]);
  assert.deepEqual(versions!.map((v) => v.summary), ['Build C', 'Build B', 'Build A', 'Build A']);
});

test('listGitVersions returns null when there is no git history / repo (→ snapshot fallback)', async () => {
  const fj = fakeForgejo(new Map()); // no repos = unreachable
  assert.equal(await listGitVersions(fj, systemRepo('ghost')), null);
});

test('shaForVersion resolves a UI index to a commit sha (and null out of range)', async () => {
  const { repos, repo } = seedRepo();
  const fj = fakeForgejo(repos);
  const head = await shaForVersion(fj, repo, 0);
  const older = await shaForVersion(fj, repo, 2);
  assert.ok(head && older && head !== older, 'distinct shas for distinct indexes');
  assert.equal(await shaForVersion(fj, repo, 99), null, 'out-of-range → null');
});

test('restoreGitVersion writes a NEW revert commit with the prior contents (non-destructive)', async () => {
  const { repos, repo } = seedRepo();
  const fj = fakeForgejo(repos);
  const before = (await listGitVersions(fj, repo))!;
  const commitsBefore = repos.get(repo)!.commits.length;

  // Restore "Build A" (oldest system.yaml). Its content was '# build A'.
  const targetSha = await shaForVersion(fj, repo, before.length - 1);
  assert.ok(targetSha);
  const { yaml } = await restoreGitVersion(fj, repo, targetSha!, 'alex');
  assert.match(yaml, /build A/, 'returned the restored system.yaml');

  const r = repos.get(repo)!;
  // Non-destructive: history GREW (a new commit), nothing was reset/removed.
  assert.ok(r.commits.length > commitsBefore, 'restore appended commit(s), never reset');
  // HEAD now holds the restored content...
  assert.equal(r.tip.get('system.yaml'), 'version: "1"\n# build A');
  // ...and the new HEAD commit is labelled as a restore of the target sha.
  assert.match(r.commits[0].message, /restore of/);
  assert.match(r.commits[0].message, new RegExp(targetSha!.slice(0, 8)));
  // The older commits are all still present (auditable, reversible).
  assert.ok(r.commits.some((c) => c.message === 'Build C'), 'prior builds retained');
});

test('restoreGitVersion throws when the commit is unreadable (unreachable Forgejo)', async () => {
  const fj = fakeForgejo(new Map()); // unreachable
  await assert.rejects(() => restoreGitVersion(fj, systemRepo('sys1'), 'sha0001', 'alex'), /Could not read commit/);
});
