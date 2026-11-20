/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — the `knowledge-workflow` reader for the generic git history / version / diff
 * USER STORY: As a domain member I want the history of a shared workflow's OKF files — who changed
 *             them, when, and what — through the same drawer every other artefact has.
 * ARCHITECTURE:
 *   - Registered at boot under `knowledge-workflow`. Runs the tab's own governed read AS the caller:
 *     an invisible or absent workflow is `null` (one byte-identical `not_found` from the kernel).
 *   - The folder is placed exactly as the writer places it (`placeWorkflows` over the domain's
 *     bundled workflows), so the selector is the folder the commit wrote.
 *   - A Personal draft is never in the domain repository, so it has no history here: `null`.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { GitObjectLocation } from '@core/infra/git-objects';
import { knowledgeWorkflowDir } from '@core/infra/repo-layout';
import { getWorkflow, listAllForIndex } from '@tabs/knowledge/lib/store';
import { bundledWorkflows, placeWorkflows } from '@tabs/knowledge/lib/git/bundle';

export function knowledgeWorkflowGitObjectResolver(user: CurrentUser, id: string): GitObjectLocation | null {
  let rec;
  try {
    rec = getWorkflow(id, user);
  } catch {
    return null;
  }
  if (!rec || rec.visibility === 'Personal' || rec.archived) return null;
  const domainRecords = listAllForIndex().map((x) => x.record).filter((r) => r.domain === rec.domain);
  const placed = placeWorkflows(bundledWorkflows(rec.domain, domainRecords)).find((p) => p.w.id === id);
  if (!placed) return null;
  return { domain: rec.domain, paths: [`${knowledgeWorkflowDir(placed.slug)}/`], trailerId: rec.id, name: rec.title };
}
