/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { QualityBadge } from '../data/dq.ts';

/**
 * The Monitoring-tab DATA-QUALITY ROLLUP (Data Quality Phase 1 · §5.2) — PURE ranking.
 *
 * A read-only tenant/domain overview: governed datasets ranked by RISK so the few that
 * need a human lead, greens recede. It reuses the SAME persisted `dq-results` runs the
 * Validate stage does — no second store, no re-run. Author quality in Data; monitor it
 * here. Each row deep-links back to that dataset's Validate stage (monitor here, fix
 * there — the hybrid IA).
 *
 * Pure: dataset-summaries + their latest runs in → ranked rows + a domain roll-up out,
 * no engine, no network, so the risk ordering is unit-tested. Scoping happens BEFORE this
 * (the route filters to the viewer's My/Domain/Company scope); this module only ranks.
 */

/** The per-dataset input: identity + its most recent persisted run (null = never run). */
export type DqDatasetInput = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  latest: {
    ranAt: string;
    badge: QualityBadge;
    healthScore: number | null;
    /** Number of checks/monitors that failed in that run. */
    openFailures: number;
    /** Whether the freshness monitor failed (SLA missed) in that run. */
    freshnessLate: boolean;
  } | null;
};

export type DqRiskRow = {
  id: string;
  name: string;
  owner: string;
  domain: string;
  badge: QualityBadge;
  healthScore: number | null;
  openFailures: number;
  freshnessLate: boolean;
  ranAt: string | null;
  /** 0–100 — higher is riskier. Drives the ordering; surfaced for transparency. */
  risk: number;
};

export type DqOverview = {
  /** Datasets ranked riskiest-first. */
  rows: DqRiskRow[];
  /** Mean health across datasets that have a score (null when none ran). */
  domainHealth: number | null;
  /** Count of datasets currently failing. */
  failing: number;
  /** Count of open failures across all datasets. */
  openFailures: number;
  /** How many datasets have never been run (honest gap, not a fake green). */
  neverRun: number;
};

/**
 * A 0–100 risk score for one dataset (higher = needs attention sooner). Honest ordering:
 *   - a FAILING dataset is always riskier than a passing one (base 60),
 *   - a never-run dataset carries real uncertainty (base 40) — not a fake green,
 *   - low health, open failures and a missed freshness SLA each add weight.
 * A clean, recently-passing dataset scores near 0 so it recedes.
 */
export function riskScore(input: DqDatasetInput): number {
  const l = input.latest;
  if (!l) return 40; // never run — unknown, not safe.
  let risk = 0;
  if (l.badge === 'failing') risk += 60;
  else if (l.badge === 'unknown') risk += 40;
  // Lower health ⇒ more risk (0 health adds 25, full health adds 0).
  if (typeof l.healthScore === 'number') risk += Math.round((100 - l.healthScore) * 0.25);
  else risk += 15; // no score is itself uncertainty.
  risk += Math.min(15, l.openFailures * 5); // each open failure, capped.
  if (l.freshnessLate) risk += 10;
  return Math.max(0, Math.min(100, risk));
}

/** Build the ranked overview from the (already scope-filtered) dataset inputs. */
export function buildDqOverview(inputs: DqDatasetInput[]): DqOverview {
  const rows: DqRiskRow[] = inputs.map((d) => ({
    id: d.id,
    name: d.name,
    owner: d.owner,
    domain: d.domain,
    badge: d.latest?.badge ?? 'unknown',
    healthScore: d.latest?.healthScore ?? null,
    openFailures: d.latest?.openFailures ?? 0,
    freshnessLate: d.latest?.freshnessLate ?? false,
    ranAt: d.latest?.ranAt ?? null,
    risk: riskScore(d),
  }));
  // Riskiest first; ties broken by lower health, then name (stable, readable ordering).
  rows.sort((a, b) => b.risk - a.risk || (a.healthScore ?? 0) - (b.healthScore ?? 0) || a.name.localeCompare(b.name));

  const scored = rows.map((r) => r.healthScore).filter((s): s is number => typeof s === 'number');
  const domainHealth = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const failing = rows.filter((r) => r.badge === 'failing').length;
  const openFailures = rows.reduce((sum, r) => sum + r.openFailures, 0);
  const neverRun = rows.filter((r) => r.ranAt === null).length;
  return { rows, domainHealth, failing, openFailures, neverRun };
}
