/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Audience changes — who can see an artifact — are always named and always audited
 * USER STORY: As an auditor I want every change of an artifact's tier, visibility or grants (a
 *             dataset going private → domain, a file shared, a grant added) to leave an audit
 *             event naming the actor, the artifact id and the exact before → after, whichever
 *             route, MCP tool, approval door or yaml edit caused it.
 * ARCHITECTURE:
 *   - Pure + dependency-light (the audit store only), so a tab store reachable from the client
 *     bundle may call it. Each store calls {@link recordAudienceChange} from its ONE write path
 *     (`persist`), comparing the record it is about to overwrite with the one it writes, so a new
 *     caller cannot skip it (incident 2026-11-23: ds_ac4aea92… flipped private → domain with no
 *     version and no audit event).
 *   - The audit event is `governance.audience.change` in os-audit; its `target` carries the
 *     artifact id (indexed — `data` is stored but not indexed, so an id only there is unsearchable).
 *   - A mirror failure never fails the write (the audit store's own rule).
 */
import { record as auditRecord } from '@core/policy/audit';

/** The audience-relevant fields an artifact record carries (datasets and files share them). */
export type AudienceFields = {
  /** The owning domain: a domain-tier artifact is visible to that domain's members, so a domain
   *  move changes who can see it as surely as a tier flip. */
  domain: string;
  tier: string;
  visibility: string;
  grants: { grantee: { kind: string; id: string } }[];
};

export type Audience = { domain: string; tier: string; visibility: string; grantees: string[] };

/** A comparable view: domain, tier, visibility and the sorted `kind:id` grantees. */
export function audienceOf(x: AudienceFields): Audience {
  const grantees = [...new Set((x.grants ?? []).map((g) => `${g.grantee.kind}:${g.grantee.id}`))].sort();
  return { domain: x.domain, tier: x.tier, visibility: x.visibility, grantees };
}

/**
 * The human summary of what changed, e.g. `domain a → b, tier dataset → asset, visibility private → domain,
 * grants +domain:sales`; null when the audience is unchanged.
 */
export function describeAudienceChange(before: Audience, after: Audience): string | null {
  const parts: string[] = [];
  if (before.domain !== after.domain) parts.push(`domain ${before.domain || '(none)'} → ${after.domain || '(none)'}`);
  if (before.tier !== after.tier) parts.push(`tier ${before.tier} → ${after.tier}`);
  if (before.visibility !== after.visibility) parts.push(`visibility ${before.visibility} → ${after.visibility}`);
  const was = new Set(before.grantees);
  const now = new Set(after.grantees);
  const added = after.grantees.filter((g) => !was.has(g));
  const removed = before.grantees.filter((g) => !now.has(g));
  if (added.length || removed.length) {
    parts.push(`grants ${[...added.map((g) => `+${g}`), ...removed.map((g) => `-${g}`)].join(' ')}`);
  }
  return parts.length ? parts.join(', ') : null;
}

export type AudienceChange = {
  /** Artifact family: `dataset`, `file`, … */
  kind: string;
  id: string;
  name: string;
  domain: string;
  /** Who caused it (`system` for a sweep with no session). */
  actor: string;
  /** The operation that caused it (`promote`, `unshare`, `edit dataset.yaml`, …). */
  via: string;
  before: Audience;
  after: Audience;
};

/**
 * Write the audit event for an audience change. Returns the summary it recorded, or null (and
 * records nothing) when the audience did not change.
 */
export function recordAudienceChange(c: AudienceChange): string | null {
  const summary = describeAudienceChange(c.before, c.after);
  if (!summary) return null;
  try {
    auditRecord({
      actor: c.actor,
      action: 'audience.change',
      subject: `${c.kind}:${c.id} (${c.name})`,
      domain: c.domain,
      reason: `${c.via}: ${summary}`,
      detail: { kind: c.kind, id: c.id, name: c.name, via: c.via, before: c.before, after: c.after },
    });
  } catch (e) {
    console.error(`[audience] audit of ${c.kind} ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return summary;
}
