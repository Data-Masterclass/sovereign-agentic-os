/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Clone a domain repo from the OS's git daemon and read git's own history
 * USER STORY: As AT-a/AT-e/AT-f I want "the note was authored by u123" and "this is the live
 *             sha" to be git's record, and I want a real clone for the eject test.
 * ARCHITECTURE:
 *   - git-daemon serves the bare repos (Service `os-repos`, git:// on 9418). Clone into a fresh
 *     temporary directory; read with plain `git log` / `git for-each-ref`.
 */
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { baseUrl } from '../endpoints.mjs';
import { HopError } from '../hop.mjs';

const exec = promisify(execFile);

/** Run git; on failure the HopError's `detail` holds git's complete stderr (receive-hook output included). */
export async function git(args, cwd) {
  try { return (await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout; } catch (err) {
    const stderr = String(err.stderr || err.message).trim();
    throw new HopError({ component: 'git', hop: `git ${args[0]}`, reason: stderr.slice(0, 300), detail: stderr });
  }
}

export async function clone(domain, { ref } = {}) {
  const port = new URL(await baseUrl('gitDaemon')).port;
  const dir = await mkdtemp(join(tmpdir(), `e2e-${domain}-`));
  await git(['clone', '--quiet', `git://127.0.0.1:${port}/${domain}.git`, dir]);
  if (ref) await git(['checkout', '--quiet', ref], dir);
  return dir;
}

/** Commits touching `path`, newest first: {sha, author, email, subject}. */
export async function logFor(dir, path) {
  const out = await git(['log', '--format=%H%x09%an%x09%ae%x09%s', '--', path], dir);
  return out.split('\n').filter(Boolean).map((l) => { const [sha, author, email, subject] = l.split('\t'); return { sha, author, email, subject }; });
}

export async function refs(dir, pattern = 'refs/') {
  const out = await git(['for-each-ref', '--format=%(refname)%09%(objectname)', pattern], dir);
  return out.split('\n').filter(Boolean).map((l) => { const [ref, sha] = l.split('\t'); return { ref, sha }; });
}
