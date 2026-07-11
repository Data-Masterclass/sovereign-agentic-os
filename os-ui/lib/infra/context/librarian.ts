/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type AssembledContext,
  assembleContext,
  type Candidate,
  compactToolResult,
  estimateTokens,
  type CompactionOptions,
  type ScoreCandidate,
} from './context-assembler.ts';

/**
 * THE CONTEXT LIBRARIAN (pure, tested) — a governed, need-aware CURATION stage
 * that runs IN FRONT of the budget-aware packer in {@link assembleContext}.
 *
 * WHY: naive head-truncation (the 0.1.78 `keepRows` band-aid) and the 0.1.79
 * loop-breaker are downstream symptoms of the SAME cause — when the candidate
 * pool is bigger than the model window, the packer keeps items by priority ×
 * recency, not by RELEVANCE to the agent's actual need. A recommender that needs
 * the WHOLE scorecard from the node before it can lose it to a stale-but-recent
 * history blob. The Librarian fixes the SELECTION: it embeds the agent's NEED
 * (its role/prompt + the current task) and each competing chunk, scores by cosine
 * similarity, and keeps the material the agent actually needs — whole — while
 * compacting the mid-relevance and dropping the low-relevance filler.
 *
 * IT IS A CURATOR, NEVER A GOVERNANCE BYPASS. Candidates arriving here are ALREADY
 * DLS/OPA-filtered upstream. The Librarian only SELECTS among entitled items; it
 * never fetches, widens access, or reaches outside its inputs. Given the same
 * inputs (embed fn injected) it is deterministic and side-effect-free.
 *
 * CURATE-WHEN-CROWDED: if the pool already fits the budget, everything is kept and
 * NOTHING is embedded (no cost in the common case). The Librarian only engages
 * when candidates exceed the budget.
 *
 * GRACEFUL FALLBACK: if no embedder is injected, or the embedder errors, the
 * Librarian does NOT curate — it returns the candidates untouched and flags the
 * fallback, so {@link assembleContext} proceeds with its existing deterministic
 * pinned-first + compaction packer. Curation NEVER breaks or blocks a run.
 */

/** Inject the embedding function so the Librarian is unit-testable and degrades
 *  gracefully. Mirrors `lib/knowledge/embed.ts`'s `embed(texts) → vectors[]` shape
 *  (the live wiring passes an adapter over that same `sovereign-embed` path). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * A curation-aware candidate: the base {@link Candidate} plus two optional,
 * DETERMINISTIC must-keep signals the role ruleset consults BEFORE relevance:
 *   • `pin` — an alias for kind:'pinned' semantics on a non-pinned item that must
 *     still be kept whole (rarely needed; kind:'pinned' is the usual path).
 *   • `predecessor` — this item is the immediate handoff / direct-predecessor
 *     structured output (e.g. the evaluator's scorecard for the recommender). It
 *     is kept in FULL regardless of its embedding score (the recommender-needs-
 *     the-whole-scorecard case).
 */
export type CurateCandidate = Candidate & {
  predecessor?: boolean;
};

/** One line of the curation trace — what happened to a candidate and why. */
export type CurationTraceEntry = {
  id: string;
  action: 'kept-full' | 'compacted' | 'dropped';
  reason:
    | 'pinned'
    | 'predecessor'
    | 'high-relevance'
    | 'mid-relevance'
    | 'low-relevance'
    | 'fits';
  score?: number;
};

export type CurationResult = {
  /** The curated candidate set — pinned + must-keep whole, mid compacted, ready
   *  for {@link assembleContext}'s packer to finish under the same budget. */
  candidates: Candidate[];
  /** True when the Librarian actively curated (embedded + selected). False when it
   *  passed the pool through untouched (under-budget, or a fallback). */
  curated: boolean;
  /** Set when the Librarian declined to curate — the honest reason. */
  fallback?: 'under-budget' | 'no-embedder' | 'embed-error';
  /** A small manifest of what was kept-full / compacted / dropped, and why. */
  trace: CurationTraceEntry[];
};

export type CurateInput = {
  /** The candidate pool (already DLS/OPA-filtered upstream). */
  candidates: CurateCandidate[];
  /** The token budget the curated set is being prepared to fit. */
  budget: number;
  /** The agent's NEED: role/prompt + current query/task. Embedded as the anchor
   *  the non-pinned candidates are scored against. */
  need: string;
  /** Injected embedder. Absent → graceful fallback (no curation). */
  embed?: EmbedFn;
  /** Compaction knobs, forwarded to `compactToolResult` for mid-relevance items. */
  compaction?: CompactionOptions;
  /** Curation thresholds (defaults sensible; exposed for tests). */
  thresholds?: CurateThresholds;
  /**
   * Phase 2 seam — an OPTIONAL LLM-curator escalation for the hardest over-budget
   * cases. NOT wired in Phase 1. See {@link EscalateFn}.
   */
  escalate?: EscalateFn;
};

export type CurateThresholds = {
  /** A `tool-result` scoring at/above this cosine similarity is kept in FULL
   *  (the "this material is clearly what the agent needs" rule). */
  keepFullAbove?: number;
  /** A candidate scoring below this is DROPPED first when still over budget. */
  dropBelow?: number;
};

const DEFAULT_THRESHOLDS: Required<CurateThresholds> = {
  keepFullAbove: 0.5,
  dropBelow: 0.15,
};

// ---------------------------------------------------------------------------
// Phase 2 seam (DESIGN ONLY — do NOT implement an LLM call in Phase 1).
// ---------------------------------------------------------------------------
/**
 * Phase 2: an injectable LLM-curator escalation, used ONLY for the hardest
 * over-budget cases (e.g. many mid-relevance chunks that all score similarly, so
 * embeddings alone can't decide what the agent truly needs). Given the entitled
 * candidates, the need, and the budget, it returns a SELECTION — the ids to keep
 * whole, to compact, and to drop. It is governed exactly like the rest of the
 * Librarian: it only SELECTS among the entitled inputs, never fetches or widens.
 *
 * Phase 1 defines this interface and leaves the hook on {@link CurateInput}; it
 * does NOT call any LLM. When `escalate` is wired (Phase 2), `curateContext` would
 * consult it after embedding, before the deterministic pack, for the over-budget
 * tail — and STILL fall back to the embedding selection if escalation errors.
 */
export type EscalateSelection = {
  keepFull: string[];
  compact: string[];
  drop: string[];
};
export type EscalateFn = (
  candidates: CurateCandidate[],
  need: string,
  budget: number,
) => Promise<EscalateSelection>;

// ---------------------------------------------------------------------------

/** Cosine similarity of two vectors. The live `sovereign-embed` vectors are L2-
 *  normalized (see `embed-core.ts`), so this is a dot product; we normalize
 *  defensively so an un-normalized injected embedder still ranks correctly. */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** True when a candidate must be kept WHOLE by the deterministic ruleset, before
 *  any relevance scoring. Pinned and the immediate predecessor handoff qualify. */
function isMustKeep(c: CurateCandidate): boolean {
  return c.kind === 'pinned' || c.predecessor === true;
}

/**
 * CURATE the candidate pool for the agent's need within the budget.
 *
 * Contract:
 *   • UNDER BUDGET → returns every candidate untouched, no embed call, curated:false.
 *   • NO EMBEDDER / EMBED THROWS → returns every candidate untouched (fallback), so
 *     the caller's existing packer runs. NEVER throws.
 *   • OVER BUDGET with an embedder → embeds the need + each non-pinned candidate,
 *     then:
 *       - pinned + predecessor must-keeps are kept in FULL (deterministic, wins
 *         over scores);
 *       - a `tool-result` scoring ≥ keepFullAbove is kept in FULL;
 *       - remaining items compete on relevance: highest kept whole while budget
 *         allows, then mid-relevance COMPACTED (reuse `compactToolResult`), then
 *         lowest DROPPED — until it fits.
 *   • Returns the curated candidate set PLUS a trace (ids + action + reason).
 *
 * Note: the result may still be marginally over budget in pathological cases (all
 * must-keeps huge). That is fine — {@link assembleContext}'s packer is the HARD
 * ceiling and truncates pinned as the last resort. The Librarian's job is
 * SELECTION quality, not the final byte-exact bound.
 */
export async function curateContext(input: CurateInput): Promise<CurationResult> {
  const budget = Math.max(0, Math.floor(input.budget));
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const candidates = input.candidates;

  // (0) Curate-when-crowded: if the pool already fits, keep everything, no embed.
  const poolTokens = candidates.reduce((n, c) => n + estimateTokens(c.text), 0);
  if (poolTokens <= budget) {
    return {
      candidates,
      curated: false,
      fallback: 'under-budget',
      trace: candidates.map((c) => ({ id: c.id, action: 'kept-full', reason: 'fits' })),
    };
  }

  // (1) No embedder → graceful fallback: hand the pool back untouched.
  if (!input.embed) {
    return passthrough(candidates, 'no-embedder');
  }

  // (2) Embed the need + each NON-must-keep candidate (must-keeps are kept whole
  //     regardless of score, so we don't spend embeddings on them). One batched
  //     call; cache by id so a chunk is never re-embedded within this call.
  const scorable = candidates.filter((c) => !isMustKeep(c));
  const scoreById = new Map<string, number>();
  try {
    if (scorable.length > 0) {
      // Score against the compacted-for-scoring text so a huge row-set is embedded
      // by its shape, not truncated arbitrarily — cheaper and more stable.
      const texts = [input.need, ...scorable.map((c) => c.text)];
      const vectors = await input.embed(texts);
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        return passthrough(candidates, 'embed-error');
      }
      const needVec = vectors[0];
      scorable.forEach((c, i) => scoreById.set(c.id, cosine(needVec, vectors[i + 1])));
    }
  } catch {
    // Embedder unavailable/errored → fall back to the existing packer. Never break.
    return passthrough(candidates, 'embed-error');
  }

  // (3) DETERMINISTIC role / must-keep rules take precedence over scores.
  const trace: CurationTraceEntry[] = [];
  const out: Candidate[] = [];
  let used = 0;

  // 3a) Must-keeps (pinned + predecessor) — kept WHOLE, first.
  for (const c of candidates) {
    if (!isMustKeep(c)) continue;
    out.push(stripCuration(c));
    used += estimateTokens(c.text);
    trace.push({
      id: c.id,
      action: 'kept-full',
      reason: c.kind === 'pinned' ? 'pinned' : 'predecessor',
    });
  }

  // 3b) The rest, ranked by relevance (highest first). A tool-result scoring above
  //     keepFullAbove is a must-keep-in-full too (clearly the needed material).
  const ranked = scorable
    .map((c) => ({ c, score: scoreById.get(c.id) ?? 0 }))
    .sort((a, b) => b.score - a.score);

  for (const { c, score } of ranked) {
    const remaining = budget - used;
    const fullTokens = estimateTokens(c.text);
    const keepFull =
      (c.kind === 'tool-result' && score >= thresholds.keepFullAbove) ||
      fullTokens <= remaining;

    if (score < thresholds.dropBelow && remaining < fullTokens) {
      trace.push({ id: c.id, action: 'dropped', reason: 'low-relevance', score });
      continue;
    }

    if (keepFull && fullTokens <= remaining) {
      out.push(stripCuration(c));
      used += fullTokens;
      trace.push({
        id: c.id,
        action: 'kept-full',
        reason: score >= thresholds.keepFullAbove ? 'high-relevance' : 'mid-relevance',
        score,
      });
      continue;
    }

    // Mid-relevance (or doesn't fit whole): compact and keep if the compacted form
    // fits; otherwise drop. Reuses the SAME compactor the packer uses downstream.
    const compacted = compactToolResult(c.text, input.compaction);
    const compactedTokens = estimateTokens(compacted);
    if (compactedTokens <= remaining) {
      out.push({ ...stripCuration(c), text: compacted });
      used += compactedTokens;
      trace.push({ id: c.id, action: 'compacted', reason: 'mid-relevance', score });
    } else {
      trace.push({ id: c.id, action: 'dropped', reason: 'low-relevance', score });
    }
  }

  return { candidates: out, curated: true, trace };
}

/** Return the pool untouched with a fallback reason — the caller's existing packer
 *  then runs on the full pool (the current, always-safe behavior). */
function passthrough(
  candidates: CurateCandidate[],
  fallback: CurationResult['fallback'],
): CurationResult {
  return {
    candidates: candidates.map(stripCuration),
    curated: false,
    fallback,
    trace: candidates.map((c) => ({ id: c.id, action: 'kept-full', reason: 'fits' as const })),
  };
}

/** Drop the Librarian-only fields so the result is a plain {@link Candidate}. */
function stripCuration(c: CurateCandidate): Candidate {
  const { predecessor: _p, ...base } = c;
  return base;
}

// ---------------------------------------------------------------------------
// ASYNC ENTRY POINT — curate, then hand the curated set to the SYNC packer.
// ---------------------------------------------------------------------------

export type CurateThenAssembleInput = {
  /** The agent's NEED (role/prompt + task) — the relevance anchor for curation. */
  need: string;
  candidates: CurateCandidate[];
  budget: number;
  /** Injected embedder. Absent → curation passes through (see {@link curateContext}). */
  embed?: EmbedFn;
  /** Compaction knobs, shared by the curator and the downstream packer. */
  compaction?: CompactionOptions;
  /** Curation thresholds (exposed for tests). */
  thresholds?: CurateThresholds;
  /** Override the packer's scorer (Phase-2 relevance in the packer). Rarely needed. */
  scoreCandidate?: ScoreCandidate;
};

export type CurateThenAssembleResult = AssembledContext & {
  /** True when the Librarian actively curated (embedded + selected) before packing. */
  curated: boolean;
  /** The honest reason the Librarian declined to curate, if it did. */
  fallback?: CurationResult['fallback'];
  /** The curation manifest (kept-full / compacted / dropped, and why). */
  trace: CurationTraceEntry[];
};

/**
 * The ASYNC context entry point for callers that can curate: it runs the (async)
 * Librarian FIRST, then feeds the curated candidates into the EXISTING synchronous
 * {@link assembleContext} packer — returning the same {@link AssembledContext} shape
 * (plus the curation flags/trace). The sync `assembleContext` is untouched, so every
 * existing sync caller keeps working; only async callers reach for this.
 *
 * NEED is used as the curation relevance anchor AND as the packer's `query` (the
 * Phase-1 deterministic scorer ignores it, so this is forward-compatible with a
 * relevance scorer in the packer without changing behaviour today).
 */
export async function curateThenAssemble(
  input: CurateThenAssembleInput,
): Promise<CurateThenAssembleResult> {
  const curation = await curateContext({
    candidates: input.candidates,
    budget: input.budget,
    need: input.need,
    embed: input.embed,
    compaction: input.compaction,
    thresholds: input.thresholds,
  });
  const assembled = assembleContext({
    query: input.need,
    budget: input.budget,
    candidates: curation.candidates,
    compaction: input.compaction,
    scoreCandidate: input.scoreCandidate,
  });
  return {
    ...assembled,
    curated: curation.curated,
    fallback: curation.fallback,
    trace: curation.trace,
  };
}
