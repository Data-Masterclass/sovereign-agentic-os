/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The approval behind a My → Domain promotion, carried to the git writer that records
 *             the promotion as a merge (component design 12)
 * USER STORY: As a domain admin I want the domain repo's history to show WHO approved a promotion
 *             and WHICH approval it was, on the merge commit that brought the artifact in from its
 *             owner's personal repository.
 * ARCHITECTURE:
 *   - AsyncLocalStorage, exactly like `request-surface.ts`: the governed effect (`core/policy/
 *     effects.ts`) runs the tab's promote inside `runWithPromotion`, and the tab's commit hook —
 *     which reads its context synchronously in the writer's turn — learns the approval without the
 *     store API growing a parameter. Outside a promotion there is no context and no merge: never
 *     a fabricated approval.
 *   - The approval LOGIC is untouched (WP-29 moves it to OPA); this only records its outcome.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type PromotionContext = {
  approvalId: string;
  approverId: string;
  approverName?: string;
};

const KEY = Symbol.for('soa.git-promote.context');
function als(): AsyncLocalStorage<PromotionContext> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<PromotionContext> | undefined>;
  if (!g[KEY]) g[KEY] = new AsyncLocalStorage<PromotionContext>();
  return g[KEY]!;
}

export function runWithPromotion<T>(ctx: PromotionContext, fn: () => T): T {
  return als().run(ctx, fn);
}

export function currentPromotion(): PromotionContext | undefined {
  return als().getStore();
}

/** The trailers a promotion merge commit carries. */
export function promotionTrailers(ctx: PromotionContext): Record<string, string> {
  return {
    'OS-Approval': ctx.approvalId,
    'OS-Approved-By': ctx.approverName ? `${ctx.approverName} <${ctx.approverId}>` : ctx.approverId,
  };
}
