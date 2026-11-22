/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Test helper - a checks runner that reports every required gate green.
 * USER STORY: As a test author checking something other than the quality gates (a scan, an approval, a
 *             deploy runner) I want a container-app deploy request not to need a CI engine.
 * ARCHITECTURE: installs the review.ts test seam. The real logic is covered by tabs/software/lib/
 *             {factory-gate-keying,tekton-record,tekton-checks,check-record}.test.ts and the kind e2e.
 */
import { __setChecksRunnerForTests } from '@tabs/software/lib/review';
import { recordFromOutcome } from '@tabs/software/lib/check-record';
import { REQUIRED_GATES } from '@tabs/software/lib/gates';

export function useGreenGates(): void {
  __setChecksRunnerForTests(async (i) => ({
    record: recordFromOutcome({
      sha: i.sha,
      trigger: i.trigger,
      engine: 'test-double',
      startedAt: 't0',
      finishedAt: 't1',
      outcome: { ok: true, report: { schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: REQUIRED_GATES.map((id) => ({ id, status: 'pass', detail: 'green (test double)' })) } },
    }),
    superseded: [],
  }));
}
