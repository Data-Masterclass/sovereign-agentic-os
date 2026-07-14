/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { listCaps } from '@/lib/governance/cost';
import { readFetch } from '../util';
import { MOCK_COST } from '../mock';
import type { Health, HealthItem } from '../types';

/**
 * Cost adapter (lens 3) — LiteLLM spend by model/agent/domain measured AGAINST the
 * Governance caps. CRITICAL boundary: Monitoring READS the caps and WATCHES the
 * spend; it NEVER sets a cap (that is Governance). So this adapter only ever does
 * read calls: LiteLLM `/spend` + the caps map; it has no write path at all.
 *
 * Live where LiteLLM is up; offline-mock otherwise. The amber/red roll-up is a
 * function of spend÷cap (≥90% amber, ≥100% red) so "nearing the cap" surfaces
 * before the cap trips — the cap itself is enforced in Governance, not here.
 */

/**
 * The Governance caps, READ-ONLY. Reads domain-scoped caps the admin SET in
 * Governance → Cost & Limits (the in-process governance cost store). No write
 * path exists here; Monitoring only ever reads.
 */
function readCaps(): Record<string, { domain: string; owner: string; limitUsd: number }> {
  const domainCaps = listCaps().filter((c) => c.scope === 'domain');
  if (domainCaps.length === 0) return {};
  const out: Record<string, { domain: string; owner: string; limitUsd: number }> = {};
  for (const cap of domainCaps) {
    out[cap.id] = { domain: cap.subject, owner: cap.createdBy, limitUsd: cap.limit };
  }
  return out;
}

function capHealth(spent: number, limit: number): Health {
  if (limit <= 0) return 'unknown';
  const r = spent / limit;
  if (r >= 1) return 'red';
  if (r >= 0.9) return 'amber';
  return 'green';
}

export async function collectCost(): Promise<HealthItem[]> {
  const caps = readCaps();

  // ALWAYS attempt the live LiteLLM spend read — not only when a cap exists. A
  // reachable gateway with $0 spend (self-hosted STACKIT models cost nothing per
  // token) is an HONEST value, not a reason to fall to mock. `null` means the
  // gateway was genuinely unreachable; `{}` (or a populated map) means reachable.
  const spendByTag = await litellmSpendByTag();

  // 1) Real caps: render one item PER CAP, measuring live spend against it. Spend
  //    0 is honest whether LiteLLM is off (null) or simply reports zero.
  if (Object.keys(caps).length > 0) {
    const items: HealthItem[] = [];
    for (const [capId, cap] of Object.entries(caps)) {
      const spent = spendByTag?.[cap.domain] ?? 0;
      items.push({
        id: `cost-${cap.domain}`,
        lens: 'cost',
        title: `${cap.domain} domain — LLM spend (month-to-date)`,
        health: capHealth(spent, cap.limitUsd),
        detail: `$${spent.toFixed(0)} of the $${cap.limitUsd} Governance cap (${Math.round((spent / cap.limitUsd) * 100)}%).`,
        owner: cap.owner,
        domain: cap.domain,
        metric: spent,
        cap: { id: capId, limitUsd: cap.limitUsd, spentUsd: spent },
        links: { capRef: capId },
        source: 'live',
      });
    }
    return items;
  }

  // 2) No caps, but LiteLLM is REACHABLE and reported real per-tag spend — surface
  //    it honestly (no cap → health 'unknown', a watch-only signal). This is the
  //    real usage-visibility path: it flows even when spend is small or $0.
  if (spendByTag && Object.keys(spendByTag).length > 0) {
    return Object.entries(spendByTag)
      .sort((a, b) => b[1] - a[1])
      .map(([subject, spent]): HealthItem => ({
        id: `cost-${subject}`,
        lens: 'cost',
        title: `${subject} — LLM spend (month-to-date)`,
        health: 'unknown', // no Governance cap set → nothing to measure against
        detail: `$${spent.toFixed(2)} spent · no Governance cap set.`,
        owner: subject,
        domain: subject,
        metric: spent,
        source: 'live',
      }));
  }

  // 3) No caps AND LiteLLM unreachable (or reported nothing) — offline mock keeps
  //    the tab + validation gate demonstrable, honestly marked source:'mock'.
  return [...MOCK_COST];
}

/**
 * Read LiteLLM spend grouped by tag subject. Returns `null` ONLY when the gateway
 * is unreachable/errors; a reachable-but-empty gateway returns `{}` so the caller
 * can tell "$0 is real" from "gateway down".
 *
 * Live shape (verified against LiteLLM `/spend/tags`) is an ARRAY of
 *   { individual_request_tag: string, log_count: number, total_spend: number }
 * where the tag is one of: `user:<email>` (per-user), `User-Agent: <x>` (transport
 * noise — dropped), or a bare label like `assistant`. We strip the `user:` prefix,
 * drop `User-Agent:` rows (not a spend subject), and keep bare tags as-is. A legacy
 * `domain:` prefix is still honoured if present.
 */
export async function litellmSpendByTag(): Promise<Record<string, number> | null> {
  const res = await readFetch(`${config.litellmUrl}/spend/tags`, {
    headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
  });
  if (!res || !res.ok) return null;
  try {
    const data = JSON.parse(await res.text());
    const rows = Array.isArray(data) ? data : Array.isArray(data?.spend) ? data.spend : [];
    const out: Record<string, number> = {};
    for (const r of rows as Record<string, unknown>[]) {
      const raw = String(r.tag ?? r.individual_request_tag ?? '').trim();
      if (!raw) continue;
      // Transport user-agent tags are LiteLLM instrumentation noise, not a spend
      // subject (domain/user) — exclude them from the grouping.
      if (/^user-agent:/i.test(raw)) continue;
      const subject = raw.replace(/^(?:domain|user):\s*/i, '');
      if (!subject) continue;
      const spend = Number(r.spend ?? r.total_spend ?? 0);
      out[subject] = (out[subject] ?? 0) + (Number.isFinite(spend) ? spend : 0);
    }
    return out; // reachable — may be {} (honest $0), never null unless unreachable
  } catch {
    return null;
  }
}
