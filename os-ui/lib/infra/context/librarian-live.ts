/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { embed, type EmbedResult } from '@/lib/knowledge/embed';
import type { EmbedFn } from './librarian.ts';

/**
 * LIVE WIRING for the Context Librarian.
 *
 * Adapts the OS embedder (`lib/knowledge/embed.ts` → `embed(texts) → { vectors, source }`)
 * to the injectable {@link EmbedFn} the Librarian consumes, AND surfaces the embedding
 * SOURCE. That source is the fallback guard: the offline hash embedding is deterministic
 * but semantically MEANINGLESS, so cosine relevance over hash vectors is noise — callers
 * must NOT curate-by-relevance when the source is `offline-hash`. A {@link LiveEmbedder}
 * lets a caller probe the source once and decide whether to curate or fall back to the
 * existing deterministic path (e.g. the handoff keepRows compaction).
 */
export type LiveEmbedder = {
  /** The {@link EmbedFn} to inject into the Librarian. */
  embed: EmbedFn;
  /** The source of the MOST RECENT `embed` call (undefined until the first call). */
  lastSource: () => EmbedResult['source'] | undefined;
};

/**
 * Build a live embedder over the OS `embed()` path. It records the source of each
 * batch so a caller can detect the `offline-hash` fallback AFTER embedding and skip
 * relevance curation (relevance over hash vectors is meaningless). `embed()` itself
 * never hard-fails — it degrades to the offline hash — so this adapter never throws
 * for provider reasons; a genuinely thrown error still propagates to the Librarian,
 * which treats it as its `embed-error` passthrough.
 */
export function liveEmbedder(): LiveEmbedder {
  let source: EmbedResult['source'] | undefined;
  return {
    embed: async (texts) => {
      const res = await embed(texts);
      source = res.source;
      return res.vectors;
    },
    lastSource: () => source,
  };
}

/**
 * A SELF-GUARDING {@link EmbedFn} for callers that can't post-check the source (they
 * only have the Librarian's pass/fail seam). When the live embedder degrades to the
 * offline hash — where cosine relevance is meaningless — it returns an EMPTY array,
 * which the Librarian treats as an embed failure and PASSES THE POOL THROUGH untouched
 * (its existing packer then runs). When the source is genuinely semantic it returns
 * the real vectors and curation proceeds. So relevance curation only ever engages on
 * real embeddings; otherwise the caller keeps its existing deterministic behaviour.
 */
export function guardedEmbedder(): EmbedFn {
  return async (texts) => {
    const res = await embed(texts);
    return res.source === 'offline-hash' ? [] : res.vectors;
  };
}
