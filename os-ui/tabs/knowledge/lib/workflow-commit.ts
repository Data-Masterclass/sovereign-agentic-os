/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    One commit = one reducer applied to the freshly-read workflow
 * USER STORY: As a process owner making two edits in quick succession I must keep both, instead of
 *             the second save carrying a pre-edit copy of the document and reverting the first.
 * ARCHITECTURE:
 *   - A commit is a REDUCER, never a finished document. The caller says WHAT to change; this module
 *     decides what it is changed against: the document the store just returned, committed with
 *     THAT read's sha. Sending a snapshot serialised in the render where the click happened is a
 *     lost update, and re-reading the sha right before the PATCH hid it (the check could not fire).
 *   - The store is injected, so the rule is testable against a fake with no server and no timers;
 *     `ui/commitWorkflow.ts` is the one `fetch` implementation of it.
 *   - Errors propagate: the commit queue turns them into a reported outcome. A reducer may also
 *     throw (`KnowledgeError`, e.g. the step vanished meanwhile) and is reported the same way.
 */
import { serializeWorkflow, type Workflow } from '@tabs/knowledge/lib/schema';

/** What a commit needs from the outside world: read the current document, write the next one. */
export type WorkflowStore = {
  /** The current workflow AND the sha that must accompany the next write. */
  read: () => Promise<{ workflow: Workflow; sha: string }>;
  /** Write `md`; the sha is the optimistic-concurrency token read alongside it. */
  patch: (md: string, sha: string) => Promise<void>;
};

/** A pure change: given the document as it is now, return the document as it should be. */
export type WorkflowReducer = (fresh: Workflow) => Workflow;

/** Apply `reduce` to the freshly-read workflow and commit it with that read's sha. */
export async function commitReducer(store: WorkflowStore, reduce: WorkflowReducer): Promise<void> {
  const { workflow, sha } = await store.read();
  await store.patch(serializeWorkflow(reduce(workflow)), sha);
}
