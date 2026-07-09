/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { estimateTokens } from '@/lib/knowledge/context-pack';

/**
 * THE CONTEXT ASSEMBLER (pure, tested).
 *
 * Given a token BUDGET (an input window, from `lib/models/context-windows.ts`) and
 * a set of CANDIDATES, it returns the best context that FITS — and never exceeds —
 * the budget. This is the fix for the LiteLLM 400 ContextWindowExceededError: the
 * ACT harness appended full, uncapped tool results to the transcript, which the
 * multi-node graph then inherited, compounding past the model window. The assembler
 * gives every model call a HARD input ceiling.
 *
 * Phase 1 (this file) scores candidates deterministically by priority × recency and
 * compacts large items before packing. Phase 2 will swap the `scoreCandidate` SEAM
 * for sovereign-embed cosine relevance — the hook is injectable and defaults to the
 * deterministic scorer, so nothing here changes when the embedder arrives.
 *
 * TRANSPORT-FREE and side-effect-free — trivially unit-testable.
 */

export type CandidateKind = 'pinned' | 'knowledge' | 'tool-result' | 'history';

export type Candidate = {
  kind: CandidateKind;
  /** The candidate's text. Compacted (except `pinned`) before packing if large. */
  text: string;
  /** Relative importance within its tier (higher = kept first). Default 0. */
  priority?: number;
  /** Stable id — surfaced in the manifest so callers see what was kept/dropped. */
  id: string;
  /** A recency signal (e.g. Date.now() or a monotonic step index). Higher = newer. */
  at?: number;
};

export type AssembledContext = {
  /** The included candidate texts, in packed order (pinned first). */
  texts: string[];
  /** Ids kept, in packed order. */
  includedIds: string[];
  /** Ids dropped to honour the budget (an honest manifest). */
  droppedIds: string[];
  /** Estimated tokens the assembled context uses (≤ budget, guaranteed). */
  tokensUsed: number;
  /** The budget it was assembled against. */
  budget: number;
};

/** The scoring SEAM. Phase 2 injects an embedding-relevance scorer here. */
export type ScoreCandidate = (c: Candidate, query: string) => number;

export type AssembleInput = {
  /** The current user query/goal — passed to the scorer (used by Phase-2 relevance). */
  query: string;
  /** Total input token budget the result must never exceed. */
  budget: number;
  candidates: Candidate[];
  /** Override the scorer (Phase 2 relevance). Defaults to deterministic scoring. */
  scoreCandidate?: ScoreCandidate;
  /** Compaction knobs (defaults are sensible; exposed for tests). */
  compaction?: CompactionOptions;
};

export type CompactionOptions = {
  /** Compact any non-pinned candidate whose estimate exceeds this (tokens). */
  compactOverTokens?: number;
  /** JSON row-set: keep this many leading rows. */
  keepRows?: number;
  /** Long text: keep this many leading + trailing chars (head+tail). */
  headTailChars?: number;
};

const DEFAULT_COMPACTION: Required<CompactionOptions> = {
  compactOverTokens: 500,
  keepRows: 5,
  headTailChars: 800,
};

// re-export so callers budget + assemble from one import surface.
export { estimateTokens };

/**
 * DETERMINISTIC Phase-1 scorer: priority dominates, recency breaks ties. Kinds
 * carry an implicit floor so, at equal author priority, knowledge and recent
 * tool-results outrank stale history. `at` is normalised into a small [0,1)
 * recency bonus so it never overtakes an explicit priority gap.
 */
const KIND_FLOOR: Record<CandidateKind, number> = {
  pinned: 1_000_000, // pinned is never scored (always kept); floor kept for completeness
  knowledge: 30,
  'tool-result': 20,
  history: 10,
};

export const deterministicScore: ScoreCandidate = (c) => {
  const base = KIND_FLOOR[c.kind] + (c.priority ?? 0) * 10;
  // Recency: newer `at` nudges the score within a <1 band (tie-breaker only).
  const recency = c.at ? 1 - 1 / (1 + c.at / 1e13) : 0;
  return base + recency;
};

/** True when a string looks like a JSON array/object row-set (a query result). */
function looksLikeJsonRows(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('[') || t.startsWith('{');
}

/**
 * Compact a large tool result so it can be KEPT (bounded) rather than DROPPED:
 *   • a JSON row-set → header + first N rows + "…(M more rows)";
 *   • any other long text → head + tail with a "[truncated K chars]" marker.
 * Small inputs are returned unchanged. Deterministic and side-effect-free.
 */
export function compactToolResult(text: string, opts: CompactionOptions = {}): string {
  const o = { ...DEFAULT_COMPACTION, ...opts };
  if (estimateTokens(text) <= o.compactOverTokens) return text;

  if (looksLikeJsonRows(text)) {
    try {
      const parsed = JSON.parse(text);
      const rows: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>).rows)
          ? ((parsed as Record<string, unknown>).rows as unknown[])
          : Array.isArray((parsed as Record<string, unknown>).data)
            ? ((parsed as Record<string, unknown>).data as unknown[])
            : [];
      if (rows.length > o.keepRows) {
        const head = rows.slice(0, o.keepRows);
        const more = rows.length - o.keepRows;
        return `${JSON.stringify(head, null, 0)}\n…(${more} more rows)`;
      }
    } catch {
      /* not valid JSON after all — fall through to head+tail */
    }
  }

  // Head+tail truncation for prose / non-parseable payloads.
  const n = o.headTailChars;
  if (text.length <= n * 2) return text;
  const cut = text.length - n * 2;
  return `${text.slice(0, n)}\n…[truncated ${cut} chars]…\n${text.slice(-n)}`;
}

/**
 * ASSEMBLE the best context that fits `budget`.
 *
 * Guarantees:
 *   • `pinned` candidates are ALWAYS included (they are the system + task spine).
 *   • non-pinned candidates are COMPACTED, then scored (priority × recency via the
 *     seam), then greedily packed highest-score-first into the remaining budget.
 *   • the assembled context NEVER exceeds `budget` — `tokensUsed ≤ budget` always.
 *   • dropped candidates are reported by id (an honest manifest).
 *
 * If pinned alone exceeds the budget it is HARD-TRUNCATED to fit (correctness of
 * the ceiling wins — a request that would 400 is worse than a trimmed system
 * prompt), and every non-pinned candidate is then dropped.
 */
export function assembleContext(input: AssembleInput): AssembledContext {
  const score = input.scoreCandidate ?? deterministicScore;
  const budget = Math.max(0, Math.floor(input.budget));

  const pinned = input.candidates.filter((c) => c.kind === 'pinned');
  const rest = input.candidates.filter((c) => c.kind !== 'pinned');

  const texts: string[] = [];
  const includedIds: string[] = [];
  const droppedIds: string[] = [];
  let used = 0;

  // 1) Pinned first — always included, in given order, hard-truncated if needed.
  for (const c of pinned) {
    const remaining = budget - used;
    if (remaining <= 0) {
      droppedIds.push(c.id);
      continue;
    }
    let text = c.text;
    let tokens = estimateTokens(text);
    if (tokens > remaining) {
      text = truncateToTokens(text, remaining);
      tokens = estimateTokens(text);
    }
    texts.push(text);
    includedIds.push(c.id);
    used += tokens;
  }

  // 2) Compact each non-pinned candidate, then score, then pack highest-first.
  const scored = rest
    .map((c) => {
      const text = compactToolResult(c.text, input.compaction);
      return { c, text, tokens: estimateTokens(text), s: score(c, input.query) };
    })
    .sort((a, b) => b.s - a.s);

  for (const item of scored) {
    if (used + item.tokens <= budget) {
      texts.push(item.text);
      includedIds.push(item.c.id);
      used += item.tokens;
    } else {
      droppedIds.push(item.c.id);
    }
  }

  return { texts, includedIds, droppedIds, tokensUsed: used, budget };
}

/**
 * Truncate text to at most `maxTokens` (via the ~4-chars/token estimate), leaving a
 * marker. Used only when pinned content alone overflows the budget — the last-ditch
 * guarantee that the ceiling holds.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = '\n…[truncated to fit context]…';
  const budgetChars = Math.max(0, maxTokens * 4 - marker.length);
  return text.slice(0, budgetChars) + marker;
}
