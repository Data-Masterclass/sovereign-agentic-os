/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one identifier a domain id becomes in SQL and repo names
 * USER STORY: As an admin I want two domains never to share a schema, so a new domain whose id
 *             sanitizes to an existing domain's identifier is refused.
 * ARCHITECTURE:
 *   - The same rule as the data tab's `store-fqn.domainSchema` (`iceberg.<ident>`, the landing and
 *     dbt names): lower-case, every run of non-[a-z0-9] → `_`, edges trimmed. A test in the data
 *     tab pins the two together, so the kernel never imports a tab.
 */

/** `agentic-leader-q3-2026` → `agentic_leader_q3_2026`; `a-b`, `a--b`, `a_b` → `a_b`. */
export function domainIdent(id: string): string {
  return (id || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
