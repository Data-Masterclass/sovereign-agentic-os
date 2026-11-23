/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core/kernel
 * FEATURE:    Company scope — the ONE rule for "promoted to Company ⇒ visible in every domain"
 * USER STORY: As a member of any domain I want every artifact that was promoted to Company
 *             (certified) to be visible to me — in the tab list, by direct open, in search, in
 *             grant pickers, over MCP and to my agents — whichever domain it was built in, while
 *             only its owner, its domain admin or a platform admin may change it.
 * ARCHITECTURE:
 *   - Pure + client-safe, imports nothing, so every tab store, the kernel registries, the DLS
 *     compilers and the UI can share it. Owner decision 2026-11-23: "When any of the artifacts
 *     is promoted to Company, it becomes visible across all domains." It REPLACES the earlier
 *     "strict domain isolation for every tier" for the Company tier only; My and Domain stay
 *     narrowed exactly as before.
 *   - READ only. Write/manage rights never come from here — they stay in
 *     `canManageArtifact` (owner · in-domain domain_admin · admin).
 *   - The tier vocabularies differ per tab (dataset/asset/product, Personal/Shared/Certified,
 *     Personal/Shared/Marketplace, personal/domain/marketplace); {@link isCompanyScope} is the
 *     one place that knows which of those words mean Company.
 *   - The rule has non-TypeScript twins that must say the same thing: the files DLS clause
 *     (`tabs/files/lib/dls.ts`, `tier: product`), the knowledge DLS (`retrieve-core.ts`,
 *     `visibility: Marketplace`) and the Trino/OPA read grant for a product dataset. Each has
 *     a test that pins it to this rule.
 */

/** Every persisted tier / visibility word that means "Company" (case-insensitive). */
const COMPANY_WORDS = new Set(['product', 'marketplace', 'certified', 'company']);

type Tiered = { tier?: string | null; visibility?: string | null; scope?: string | null };

/**
 * True when a tier or visibility value is the Company rung of the ladder.
 * Accepts the bare value, or a record carrying `tier`, `visibility` or `scope`.
 */
export function isCompanyScope(x: string | null | undefined | Tiered): boolean {
  if (x == null) return false;
  if (typeof x === 'string') return COMPANY_WORDS.has(x.trim().toLowerCase());
  return isCompanyScope(x.tier) || isCompanyScope(x.visibility) || isCompanyScope(x.scope);
}

/**
 * Does an item the caller may already SEE belong in a list narrowed to the caller's live
 * domains (`user.domains` is `[active]` while a domain is chosen, every membership under
 * "All domains")?
 *
 *   • a Company item — always (visible across all domains, whatever domain is active);
 *   • a domainless item — always (an unassigned artifact stays findable);
 *   • otherwise — only when its home domain is one of `domains`.
 *
 * NARROWING ONLY: it never admits an item the store's own view gate refused.
 */
export function inLiveDomainScope(item: { company: boolean; domain?: string | null }, domains: readonly string[]): boolean {
  if (item.company) return true;
  if (!item.domain) return true;
  return domains.includes(item.domain);
}
