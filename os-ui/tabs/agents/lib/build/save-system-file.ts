/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Saving system.yaml also says which grants the saver cannot use
 * USER STORY: As a builder who saves a team granting a dataset I cannot see, I want the save to
 *             succeed and tell me about that dataset in the same response.
 * ARCHITECTURE:
 *   - The PUT `/api/agents/systems/[id]/files` route delegates here (a test cannot import a
 *     `route.ts`), so the route test exercises exactly this.
 *   - The store's `writeFile` is unchanged and stays the chokepoint; `grantWarnings` is computed
 *     AFTER the write, as the saver, from the saved content. Never a gate (`grant-access.ts`).
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { writeFile, type RepoFile } from '@tabs/agents/lib/store';
import type { GrantWarning } from '@tabs/agents/lib/grant-access';
import { grantWarningsForYaml } from '@tabs/agents/lib/build/grant-access-probe';

export type SavedSystemFile = RepoFile & { grantWarnings?: GrantWarning[] };

export async function saveSystemFile(
  systemId: string,
  user: CurrentUser,
  input: { path: string; content: string; sha: string },
  deps: { warnings?: typeof grantWarningsForYaml } = {},
): Promise<SavedSystemFile> {
  const saved = writeFile(systemId, user, input);
  if (saved.path !== 'system.yaml') return saved;
  const grantWarnings = await (deps.warnings ?? grantWarningsForYaml)(user, saved.content);
  return { ...saved, grantWarnings };
}
