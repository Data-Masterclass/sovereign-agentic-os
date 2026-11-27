/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel policy
 * FEATURE:    App Builder (H) - "no other eligible reviewer": tell the requester BEFORE a go-live waits for nobody
 * USER STORY: As an app builder in a domain without a domain admin I want to see, next to "Go live", that nobody may
 *             approve my Domain go-live (I cannot approve my own), so I ask an admin to change the rule or appoint a
 *             reviewer instead of filing a card that waits forever.
 * ARCHITECTURE:
 *   - The user directory belongs to the admin tab (`tabs/admin/lib/users.ts`); the kernel never imports a tab and a tab
 *     never imports another, so the directory is installed HERE at boot (`instrumentation.ts`), like the lifecycle
 *     adapters and the grant-check port. Only the three fields the rule table needs leave it: id, role, domains.
 *     Deactivated users are not candidates.
 *   - `goLiveReviewerNotice` = W0's pure `noEligibleReviewer` over that list. NEVER THROWS, NEVER SILENT: without a
 *     directory, or when it cannot be read, the answer is `{ checked: false, reason }` (a caller shows "could not
 *     check"), never an all-clear. Advisory only: the go-live path enforces `canReview` on the decision itself.
 */
import { noEligibleReviewer, type GoLiveRequest, type GoLiveRule, type GoLiveUser } from '@core/policy/go-live-rules';

/** Every active user, as the rule table sees them. May throw; the port catches. */
export type GoLiveCandidates = () => Promise<readonly (GoLiveUser & { disabled?: boolean })[]>;

const KEY = Symbol.for('soa.core.go-live-candidates');
type Slot = { list: GoLiveCandidates | null };
function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  if (!g[KEY]) g[KEY] = { list: null };
  return g[KEY]!;
}

/** Install (or, with `null`, remove) the directory reader. The last registration wins. */
export function registerGoLiveCandidates(list: GoLiveCandidates | null): void {
  slot().list = list;
}

export type ReviewerNotice =
  | { checked: true; notice: string | null }
  | { checked: false; notice: null; reason: string };

/** Is there anybody but the requester who may approve this go-live? `notice` is null when there is (or none is needed). */
export async function goLiveReviewerNotice(rules: readonly GoLiveRule[], req: GoLiveRequest): Promise<ReviewerNotice> {
  const list = slot().list;
  if (!list) return { checked: false, notice: null, reason: 'the user directory is not available to the go-live check' };
  let users: readonly (GoLiveUser & { disabled?: boolean })[];
  try {
    users = await list();
  } catch (e) {
    return { checked: false, notice: null, reason: `the user directory could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
  const candidates = users.filter((u) => !u.disabled).map((u) => ({ id: u.id, role: u.role, domains: [...u.domains] }));
  return { checked: true, notice: noEligibleReviewer(rules, req, candidates) };
}
