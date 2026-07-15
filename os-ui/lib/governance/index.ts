/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Governance — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import the tab through THIS module.
 * Deep-path imports (e.g. `@/lib/governance/approvals`) remain valid when
 * callers need to avoid symbol collisions between sub-modules.
 *
 * Note: approvals, standing and governance each export `ensureHydrated` /
 * `StandingPolicy`; those surfaces must be imported via their direct paths.
 */

// Cost caps: setCap / addSpend / checkCap / listCaps.
export * from './cost.ts';

// Role + scope helpers: roleRank / principalFor / canSee.
export * from './roles.ts';

// Effect dispatcher for approved promotions.
export * from './effects.ts';

// Audit log: record / search / verifyChain.
export * from './audit.ts';

// Policy plane: egress allowlist, grant overrides, consolidatedPlane.
export * from './policy-view.ts';

// Promotion ladder: promoteThroughSeam / demoteThroughSeam / promoteOrRequest.
export * from './ladder.ts';
