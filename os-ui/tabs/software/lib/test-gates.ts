/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Test helper - a gates runner that reports every required gate green.
 * USER STORY: As a test author checking something other than the quality gates (a scan, an approval, a
 *             deploy runner) I want a container-app deploy request not to need a Kubernetes sandbox.
 * ARCHITECTURE: installs the review.ts test seam. The real gates logic is covered by
 *             tabs/software/lib/{factory-gate-keying,sandbox-gates-verdict,factory-gates}.test.ts.
 */
import { __setGatesRunnerForTests } from '@tabs/software/lib/review';
import { REQUIRED_GATES } from '@tabs/software/lib/gates';

export function useGreenGates(): void {
  __setGatesRunnerForTests(async () => ({
    ok: true,
    report: { schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: REQUIRED_GATES.map((id) => ({ id, status: 'pass', detail: 'green (test double)' })) },
  }));
}
