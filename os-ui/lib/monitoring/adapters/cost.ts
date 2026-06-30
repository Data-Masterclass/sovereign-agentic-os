/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
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
 * The Governance caps, READ-ONLY. On a live cluster these come from Governance's
 * cap store (LiteLLM key max_budget / the policy compiler). Offline we mirror the
 * worked-example caps so the "nearing cap" signal is demonstrable. We never write.
 */
async function readCaps(): Promise<Record<string, { domain: string; owner: string; limitUsd: number }>> {
  // The caps are AUTHORED IN GOVERNANCE; Monitoring only READS them. On a live
  // cluster this resolves the Governance cap store (LiteLLM key max_budget / the
  // policy-compiler output). Until that source is on `main` we return the
  // worked-example mirror — the exact caps Governance would hold — so the
  // "nearing the cap" signal is demonstrable. No write path exists here.
  return {
    'cap-sales-monthly': { domain: 'sales', owner: 'u_sales_rep', limitUsd: 200 },
    'cap-finance-monthly': { domain: 'finance', owner: 'u_other', limitUsd: 300 },
  };
}

function capHealth(spent: number, limit: number): Health {
  if (limit <= 0) return 'unknown';
  const r = spent / limit;
  if (r >= 1) return 'red';
  if (r >= 0.9) return 'amber';
  return 'green';
}

export async function collectCost(): Promise<HealthItem[]> {
  const caps = await readCaps();
  const spendByDomain = await litellmSpendByDomain();

  if (spendByDomain) {
    const items: HealthItem[] = [];
    for (const [capId, cap] of Object.entries(caps)) {
      const spent = spendByDomain[cap.domain] ?? 0;
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
    if (items.length > 0) return items;
  }
  // Offline-mock — Sales nearing its cap (amber), Finance comfortable (green).
  return [...MOCK_COST];
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
