/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The Software tab's `registerGitObject('software', …)` resolver (stream G's contract)
 * USER STORY: As a user I want an app's head commit, history and releases to resolve in the shared
 *             git surfaces — the same way a dataset's and an agent system's do.
 * ARCHITECTURE:
 *   - Stream G owns `core/infra/git-objects.ts` (the `GitObjectLocation` type, the registry and the
 *     generic reads). That module is NOT in this worktree, so importing it would not typecheck.
 *     The resolver is therefore written against G's contract with the location type declared
 *     LOCALLY and structurally identical, and `installSoftwareGitObject(register)` takes G's
 *     `registerGitObject` as a PARAMETER. One line in `instrumentation.ts` wires them together
 *     once both streams are merged — see deviation S-4.
 *   - `tagPrefix: 'app/<slug>/'` is what makes G's release list light up over the tag API this
 *     stream added (`listTags(domain, 'app/<slug>/v')`).
 *   - `null` means "not found OR not visible to you", indistinguishable on purpose: the resolver
 *     reads the app through `getAppForUser`, whose refusal for an invisible app is `not_found`.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { getAppForUser } from '@tabs/software/lib/apps';
import { appSubtreePrefix } from '@tabs/software/lib/git-commit';

/** Structurally identical to stream G's `GitObjectLocation` (see the header). */
export type SoftwareGitLocation = {
  domain: string;
  paths: string[];
  trailerId?: string;
  name?: string;
  tagPrefix?: string;
};

/** G's `GitObjectResolver`, for the one kind this tab owns. */
export async function resolveSoftwareGitObject(user: CurrentUser, id: string): Promise<SoftwareGitLocation | null> {
  let app;
  try {
    app = await getAppForUser(id, user);
  } catch {
    return null; // not found OR not visible — deliberately the same answer
  }
  const domain = String(app.domain ?? '').trim();
  if (!domain) return null; // no domain ⇒ no domain repository ⇒ nothing to resolve
  return {
    domain,
    paths: [`${appSubtreePrefix(app.slug)}/`],
    // The commit trailer is `OS-Object: app:<id> (<name>)`; the id half is what G matches on.
    trailerId: `app:${app.id}`,
    name: app.name,
    // Releases are annotated tags `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>` (decision D17).
    tagPrefix: `app/${app.slug}/`,
  };
}

/**
 * Register the resolver with stream G's registry. Called once at boot with G's
 * `registerGitObject` — injected rather than imported so this tab does not depend on a module
 * that is still on another branch.
 */
export function installSoftwareGitObject(
  register: (kind: 'software', resolve: typeof resolveSoftwareGitObject) => void,
): void {
  register('software', resolveSoftwareGitObject);
}
