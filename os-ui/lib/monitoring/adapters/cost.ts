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

  if (Object.keys(caps).length === 0) {
    // No governance caps set yet — fall through to offline mock.
    return [...MOCK_COST];
  }

  // Real caps exist. Spend 0 is honest when LiteLLM is offline; the cap is real.
  const spendByDomain = await litellmSpendByDomain();
  const items: HealthItem[] = [];
  for (const [capId, cap] of Object.entries(caps)) {
    const spent = spendByDomain?.[cap.domain] ?? 0;
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

/** Read LiteLLM spend grouped by domain tag. Returns null when LiteLLM is off. */
async function litellmSpendByDomain(): Promise<Record<string, number> | null> {
  const res = await readFetch(`${config.litellmUrl}/spend/tags`, {
    headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
  });
  if (!res || !res.ok) return null;
  try {
    const data = JSON.parse(await res.text());
    const rows = Array.isArray(data) ? data : Array.isArray(data?.spend) ? data.spend : [];
    if (rows.length === 0) return null;
    const out: Record<string, number> = {};
    for (const r of rows as Record<string, unknown>[]) {
      const tag = String(r.tag ?? r.individual_request_tag ?? '').replace(/^domain:/, '');
      const spend = Number(r.spend ?? r.total_spend ?? 0);
      if (tag) out[tag] = (out[tag] ?? 0) + (Number.isFinite(spend) ? spend : 0);
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
