/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Which domain repos lack the OS's list of generated files (`os/owned-files.yml`)
 * USER STORY: As an admin I want to see which domains' receive gate is failing closed (builders cannot
 *             push models/ or tests/ there) so that I can reconcile them instead of finding out from a
 *             refused push.
 * ARCHITECTURE: Reads each domain repo's head through the git store; the file is written by every OS
 *             commit (generate.ts) and by the boot reconcile. Used by the boot log, the admin
 *             reconcile route and the Monitoring platform view.
 */
import 'server-only';
import { DATA_LAYOUT } from '@core/infra/data-layout';
import { listRepos, readBlob, type GitStoreOptions } from '@core/infra/git-store';

export async function domainsMissingOwnedFiles(opts: GitStoreOptions = {}): Promise<string[]> {
  const repos = await listRepos(opts);
  const { load } = await import('js-yaml');
  const missing: string[] = [];
  for (const r of repos) {
    if (!r.head) continue;
    try {
      const doc = load(await readBlob(r.name, r.head, DATA_LAYOUT.ownedFilesPath, opts)) as { files?: unknown } | null;
      if (!doc || typeof doc !== 'object' || !doc.files || typeof doc.files !== 'object') missing.push(r.name);
    } catch {
      missing.push(r.name);
    }
  }
  return missing.sort();
}
