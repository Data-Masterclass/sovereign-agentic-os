/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The role mapping as a real file, `os/models.yml`, in the platform repository.
 * USER STORY: As a platform admin I can see who changed the role mapping and when, diff two versions
 *             and restore an old one, because it is a committed file.
 * ARCHITECTURE:
 *   - The OS's own git store (`core/infra/git-store.ts`), repository `platform`. A write replaces the
 *     `os/` subtree with every file it already holds plus the new `os/models.yml`, so another writer's
 *     files under `os/` survive. An identical write is not a commit. A file that does not parse is a
 *     typed error on read, never an empty or default mapping.
 *   - Server-only (the git store is).
 */
import 'server-only';
import { authorFor, commitSubtree, listTree, readBlob, repoExists, type GitStoreOptions } from '@core/infra/git-store';
import { OS_DIR, PLATFORM_REPO, osPath } from '@core/infra/repo-layout';
import { parseModelsYml, serializeModelsYml, type RoleMapping } from '@core/models/role-mapping';

export const MODELS_FILE = osPath('models.yml');

export type RoleStore = {
  read: () => Promise<RoleMapping | null>;
  write: (mapping: RoleMapping, actor: { id: string; name?: string | null; email?: string | null }) => Promise<{ sha: string; changed: boolean }>;
};

export function platformRoleStore(opts: GitStoreOptions = {}): RoleStore {
  return {
    async read() {
      if (!repoExists(PLATFORM_REPO, opts)) return null;
      let text: string;
      try {
        text = await readBlob(PLATFORM_REPO, undefined, MODELS_FILE, opts);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
      return parseModelsYml(text);
    },
    async write(mapping, actor) {
      const files = new Map<string, string>();
      if (repoExists(PLATFORM_REPO, opts)) {
        for (const e of await listTree(PLATFORM_REPO, undefined, opts)) {
          if (e.path.startsWith(`${OS_DIR}/`) && e.path !== MODELS_FILE) files.set(e.path, await readBlob(PLATFORM_REPO, undefined, e.path, opts));
        }
      }
      files.set(MODELS_FILE, serializeModelsYml(mapping));
      const { author } = authorFor(actor);
      return commitSubtree(PLATFORM_REPO, `${OS_DIR}/`, files, { ...opts, author, message: `models: update the role mapping (strong → ${mapping['sovereign-strong']}, worker → ${mapping['sovereign-worker']}, embedding → ${mapping['sovereign-embedding']})`, trailers: { 'OS-Actor': actor.id } });
    },
  };
}
