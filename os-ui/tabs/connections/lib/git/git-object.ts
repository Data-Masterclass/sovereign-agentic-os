/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — the `connection-config` reader for the generic git history / version / diff
 * USER STORY: As a user I want the history of a warehouse connection's catalog file — who changed
 *             it, when, and what — through the same drawer every other artefact has.
 * ARCHITECTURE:
 *   - Registered at boot (`instrumentation.ts`) under `connection-config`. Runs the tab's own
 *     governed read AS the caller: an invisible or absent connection is `null`, which the kernel
 *     turns into one byte-identical `not_found`.
 *   - Only a warehouse connection has files; any other kind of connection is `null` (no history of
 *     nothing).
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { GitObjectLocation } from '@core/infra/git-objects';
import { connectionDir } from '@core/infra/repo-layout';
import { getConnectionForUser } from '@tabs/connections/lib/store';

export async function connectionGitObjectResolver(user: CurrentUser, id: string): Promise<GitObjectLocation | null> {
  let c;
  try {
    c = await getConnectionForUser(id, user);
  } catch (e) {
    // The store's own 403/404 means "not yours or not there": the kernel turns null into one
    // byte-identical not_found. Any other failure is a real error and propagates.
    if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 403) return null;
    throw e;
  }
  if (!c || c.template !== 'warehouse' || !c.warehouse?.catalog) return null;
  return { domain: c.domain, paths: [`${connectionDir(c.warehouse.catalog)}/`], trailerId: c.id, name: c.name };
}
