/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Active operating-domain scope — the ONE place that answers "which of my
 * domains am I working in right now". A multi-domain user picks an active domain
 * from the sidebar switcher; the choice rides a cookie so it survives logout and
 * is restored on the next login (so we never need to force a pick at sign-in).
 *
 * Pure + client-safe (no server / Next imports) so the identity chokepoint
 * (`currentUser`) and the UI share the exact same rules.
 *
 * SAFETY: resolving only ever NARROWS the signed session's domains to a subset —
 * it can never add a domain the user isn't a verified member of, so it cannot
 * escalate access. An unset / stale / forged value simply falls back to "all".
 */

/** Cookie holding the chosen active domain id (absent ⇒ "All domains"). */
export const ACTIVE_DOMAIN_COOKIE = 'os_active_domain';

/** Cookie marking that the user has made ANY explicit domain choice (including
 *  "All"), so the one-time first-login prompt shows at most once per browser. */
export const DOMAIN_CHOSEN_COOKIE = 'os_domain_chosen';

export type DomainScope = {
  /** Effective scope every list + create-default uses: `[active]`, or all. */
  domains: string[];
  /** Every (non-archived) domain the user belongs to — for the switcher + admin. */
  allDomains: string[];
  /** The chosen operating domain, or `null` = all domains. */
  activeDomain: string | null;
};

/**
 * Resolve the effective domain scope from the user's full membership and the
 * requested active domain. A requested value is honored ONLY if it is a real
 * member domain; otherwise it is ignored (fall back to all) — this is the guard
 * that keeps the cookie from ever widening access.
 */
export function resolveDomainScope(allDomains: string[], requested: string | null | undefined): DomainScope {
  const active = requested && allDomains.includes(requested) ? requested : null;
  return { domains: active ? [active] : allDomains, allDomains, activeDomain: active };
}
