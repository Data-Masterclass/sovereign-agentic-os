/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino scheduling identity (source + client tags) for os-ui queries
 * USER STORY: As an operator I want each domain and user to get their own Trino resource group, so one busy
 *             user or domain cannot take every query slot of the tenant.
 * ARCHITECTURE:
 * - Pure: builds `X-Trino-Source` `os-ui/<domain>/<surface>` and client tags; governed.ts sends
 *     them to the query-tool, which passes them to Trino unchanged (design 06 §5.5, WP-13).
 */
/**
 * The scheduling identity of an os-ui query: Trino's documented client `source` and client tags
 * (https://trino.io/docs/476/develop/client-protocol.html, `X-Trino-Source`, `X-Trino-Client-Tags`).
 *
 * Trino's resource-group selector `^os-ui/(?<domain>[a-z0-9_]+)/.*` (chart
 * `trino.resourceGroups.config`, design 06 §5.5) turns `os-ui/<domain>/<surface>` into the group
 * `global.domains.<domain>.<user>`, which carries the per-domain and per-user limits. The source
 * is a scheduling input only: who may read what is decided by OPA on the session user.
 *
 * `domain` is the domain whose data the query targets, or the caller's first domain for a
 * personal-lane query (`routeFor`). It is sanitised exactly like the Iceberg namespace
 * (`tabs/data/lib/store-fqn.ts` `sanitizeIdent`), so the group name matches the schema name.
 *
 * Every os-ui query is routed explicitly; none falls through to `global.other`:
 *   - a caller with no domain gets the reserved segment `_none` (a sanitised domain never starts
 *     with `_`), so their queries still get a per-user group, `global.domains._none.<user>`;
 *   - a domain longer than `MAX_DOMAIN` characters is shortened to a prefix plus an 8-character
 *     hash of the full name, so `domain=<d>` stays a valid client tag (at most 64 characters) and
 *     two long domains never share a group.
 */
import { createHash } from 'node:crypto';

export type TrinoRoute = { domain: string; surface: string };

/** The segment for a caller with no domain. */
export const NO_DOMAIN = '_none';
/** The longest domain segment: `domain=` + 48 = 55 ≤ the 64-character client-tag limit. */
export const MAX_DOMAIN = 48;

const SURFACE = /^[a-z][a-z0-9-]{0,39}$/;

/** `sales`, `agentic-leader-q3-2026` → `agentic_leader_q3_2026`; '' → `_none`; a name longer
 *  than MAX_DOMAIN → its first 39 characters + `_` + 8 hex of sha256(full sanitised name). */
export function routeDomain(domain: string | undefined): string {
  const d = (domain ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!d) return NO_DOMAIN;
  if (d.length <= MAX_DOMAIN) return d;
  const hash = createHash('sha256').update(d).digest('hex').slice(0, 8);
  return `${d.slice(0, MAX_DOMAIN - 9).replace(/_+$/, '')}_${hash}`;
}

/** The `X-Trino-Source` value: `os-ui/<domain>/<surface>`. Throws on a malformed surface. */
export function trinoSource(route: TrinoRoute): string {
  if (!SURFACE.test(route.surface)) throw new Error(`trinoSource: bad surface "${route.surface}"`);
  return `os-ui/${routeDomain(route.domain)}/${route.surface}`;
}

/** The `X-Trino-Client-Tags` values (informational; no selector uses them). */
export function trinoClientTags(route: TrinoRoute): string[] {
  return ['os-ui', `domain=${routeDomain(route.domain)}`, `surface=${route.surface}`];
}

/** The route for a signed-in caller: the target domain when known, else their first domain. */
export function routeFor(user: { domains: readonly string[] }, surface: string, targetDomain?: string): TrinoRoute {
  return { domain: targetDomain ?? user.domains[0] ?? '', surface };
}

/**
 * The route for a query whose target is a known table: the table's schema IS its domain
 * namespace (`iceberg.<domain>.<t>`), except a personal lane (`personal_<uid>`), which is
 * scheduled under the caller's first domain.
 */
export function routeForTable(fqn: string, surface: string, domains: readonly string[]): TrinoRoute {
  const schema = fqn.split('.').length >= 3 ? fqn.split('.')[1].replace(/"/g, '') : '';
  const personal = schema === '' || schema.toLowerCase().startsWith('personal_');
  return { domain: personal ? (domains[0] ?? '') : schema, surface };
}
