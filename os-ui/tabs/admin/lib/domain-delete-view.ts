/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Whether a delete-domain plan can run, and the words for why not
 * USER STORY: As the admin reading a delete plan I want the card to tell me plainly whether the
 *             delete can run, and what exactly stops it, before I press anything.
 * ARCHITECTURE:
 *   - Pure + client-safe (no server imports): the plan card in tabs/admin/ui/DomainsAdmin.tsx
 *     renders from it. It mirrors the server's refusals (core/kernel/domain-delete.ts: any blocked
 *     object refuses the run; the button needs something to remove) — the server stays the gate.
 */

export type DeletePlanView = {
  totals: { remove: number; keep: number; blocked: number };
  components: { component: string; remove: unknown[]; keep: unknown[]; blocked?: { kind: string; label: string; reason?: string }[] }[];
};

export type DeleteRunGate = { canRun: true } | { canRun: false; why: string };

export function deleteRunGate(plan: DeletePlanView): DeleteRunGate {
  const blocks = plan.components.flatMap((c) => (c.blocked ?? []).map((b) => `${c.component}: ${b.label}${b.reason ? ` — ${b.reason}` : ''}`));
  if (blocks.length || plan.totals.blocked > 0) {
    return { canRun: false, why: `The delete cannot run yet; nothing will be removed. Blocked by ${blocks.length ? blocks.join('; ') : `${plan.totals.blocked} object(s)`}` };
  }
  if (plan.totals.remove === 0) return { canRun: false, why: 'Nothing to remove: this domain holds no objects the delete would remove.' };
  return { canRun: true };
}
