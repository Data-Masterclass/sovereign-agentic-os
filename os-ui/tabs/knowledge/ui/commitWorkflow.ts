/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Workflow } from '@tabs/knowledge/lib/schema';
import { commitReducer, type WorkflowStore, type WorkflowReducer } from '@tabs/knowledge/lib/workflow-commit';

/**
 * The one `fetch` implementation of {@link WorkflowStore} — read the workflow with its
 * sha, PATCH the next markdown with that sha. Everything else about a commit (what is
 * changed, and against which document) lives in `lib/workflow-commit.ts`, where it is
 * testable against a fake store.
 *
 * A commit is a REDUCER, never a finished document: the editor used to serialise a
 * snapshot from the render the click happened in and send it with a sha re-read right
 * before the PATCH, so two quick edits made the later one revert the earlier and the sha
 * check could never fire.
 */
/** Fallback texts when the server sends no `error` (the caller passes them in the user's language). */
export type CommitMessages = { readFailed: string; saveFailed: string };
const ENGLISH: CommitMessages = { readFailed: 'Could not read workflow', saveFailed: 'Save failed' };

export function workflowStore(workflowId: string, messages: CommitMessages = ENGLISH): WorkflowStore {
  const url = `/api/knowledge/workflows/${workflowId}`;
  return {
    async read() {
      const res = await fetch(url, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? messages.readFailed);
      return { workflow: body.workflow as Workflow, sha: String(body.sha ?? '') };
    },
    async patch(md: string, sha: string) {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ md, sha }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? messages.saveFailed);
    },
  };
}

/** Commit a change to the one source (`workflow.md`) as a reducer over the fresh document. */
export function commitWorkflow(workflowId: string, reduce: WorkflowReducer, messages?: CommitMessages): Promise<void> {
  return commitReducer(workflowStore(workflowId, messages), reduce);
}
