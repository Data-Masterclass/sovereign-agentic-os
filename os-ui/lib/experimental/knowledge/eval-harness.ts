/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type KnowledgeUnit } from './chunk.ts';
import { hashEmbed, cosine } from './embed-core.ts';
import {
  type Principal,
  type Scored,
  canSee,
  lexicalScore,
  hybridScore,
  rerank,
} from './retrieve-core.ts';

/**
 * Pure evaluation harness for the knowledge context layer — built BEFORE tuning,
 * per the design. Two suites:
 *   • GOLDEN Q&A — known queries with the evidence each MUST surface (grounded-
 *     answer rate, retrieval recall).
 *   • ACCESS CONTROL — queries run as principals who must NOT see certain units
 *     (policy-violation rate must be ≈ 0).
 * Pure + deterministic (offline embedding) so it runs in CI without a cluster; a
 * route can run the same harness over the live index for online metrics.
 */

export type EmbeddedUnit = KnowledgeUnit & { embedding: number[] };

/** Offline-embed a unit set (deterministic; mirrors the index pipeline's vectors). */
export function embedUnits(units: KnowledgeUnit[], dim = 384): EmbeddedUnit[] {
  return units.map((u) => ({ ...u, embedding: hashEmbed(u.text, dim) }));
}

/** Offline retrieve: DLS filter → dense(cosine)+lexical hybrid → rerank → top-k. */
export function retrieveOffline(
  units: EmbeddedUnit[],
  query: string,
  principal: Principal,
  k = 6,
): Scored[] {
  const qv = hashEmbed(query, units[0]?.embedding.length ?? 384);
  // Keep the EmbeddedUnit type (applyDls narrows to KnowledgeUnit) by filtering inline.
  const pool = units.filter((u) => canSee(u.provenance, principal));
  const candidates = pool.map((u) => ({
    unit: u,
    relevance: hybridScore(cosine(qv, u.embedding), lexicalScore(query, `${u.title} ${u.text}`)),
  }));
  return rerank(candidates).slice(0, k);
}

// ----------------------------------------------------------- golden Q&A -------

export type GoldenCase = {
  id: string;
  query: string;
  principal: Principal;
  /** A substring that the TOP-K must contain (in a unit id or text) to count grounded. */
  expect: string;
  k?: number;
};

export type GoldenResult = { id: string; grounded: boolean; topIds: string[] };
export type GoldenReport = { total: number; grounded: number; groundedRate: number; results: GoldenResult[] };

export function evaluateGolden(units: EmbeddedUnit[], cases: GoldenCase[]): GoldenReport {
  const results: GoldenResult[] = cases.map((c) => {
    const hits = retrieveOffline(units, c.query, c.principal, c.k ?? 6);
    const needle = c.expect.toLowerCase();
    const grounded = hits.some((h) => h.unit.id.toLowerCase().includes(needle) || h.unit.text.toLowerCase().includes(needle));
    return { id: c.id, grounded, topIds: hits.map((h) => h.unit.id) };
  });
  const grounded = results.filter((r) => r.grounded).length;
  return { total: cases.length, grounded, groundedRate: cases.length ? grounded / cases.length : 1, results };
}

// ------------------------------------------------------- access control -------

export type AccessCase = {
  id: string;
  query: string;
  principal: Principal;
  /** No returned unit may belong to this workflow id (the principal isn't granted it). */
  forbiddenWorkflowId?: string;
  /** No returned unit may have this visibility unless the principal is entitled. */
  forbidVisibility?: string;
};

export type AccessResult = { id: string; violations: number; leaked: string[] };
export type AccessReport = { total: number; violations: number; violationRate: number; results: AccessResult[] };

export function evaluateAccessControl(units: EmbeddedUnit[], cases: AccessCase[]): AccessReport {
  const results: AccessResult[] = cases.map((c) => {
    const hits = retrieveOffline(units, c.query, c.principal, 10);
    const leaked = hits
      .filter((h) =>
        (c.forbiddenWorkflowId && h.unit.provenance.workflowId === c.forbiddenWorkflowId) ||
        (c.forbidVisibility && h.unit.provenance.visibility === c.forbidVisibility),
      )
      .map((h) => h.unit.id);
    return { id: c.id, violations: leaked.length, leaked };
  });
  const violations = results.reduce((n, r) => n + r.violations, 0);
  return { total: cases.length, violations, violationRate: cases.length ? violations / cases.length : 0, results };
}
