/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Hit } from './index-store.ts';
import type { Reader } from './dls.ts';

/**
 * The rerank + passage-packaging stage of the files retrieval tool (context-layer:
 * "rerank by relevance + trust + freshness + authority"). Pure + tested so the
 * ranking is deterministic and the server tool (retrieve.ts) just wires identity,
 * OPA, embeddings, OpenSearch + Langfuse around it.
 */

export type FilePassage = {
  fileId: string;
  name: string;
  repType: string;
  snippet: string;
  deepLink: string;
  owner: string;
  domain: string;
  tier: string;
  freshness: string | null;
  /** The fused retrieval score + the rerank boosts (for transparency/eval). */
  score: number;
  trust: number;
  freshnessBoost: number;
  authority: number;
  /** Present for media: the raw original can be opened on demand (vision → STACKIT
   *  ONLY when explicitly flagged; this build never calls it). */
  openOriginal?: { kind: string; deepLink: string; vision: 'on-demand' | 'flagged-stackit' };
};

/** No service-account retrieval: the tool MUST run under the user's delegated
 *  identity (data-policy-compiler R2). Throws otherwise. */
export function assertDelegated(principal: { id?: string } | null | undefined): asserts principal is Reader {
  if (!principal || !principal.id) {
    const err = new Error('files_retrieve must run under a delegated user identity, never a service account');
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

/** Trust by sharing tier — a certified marketplace product outranks a domain asset,
 *  which outranks a private file (more eyes / governance = more trustworthy). */
export function trustOf(tier: string): number {
  return tier === 'product' ? 0.3 : tier === 'asset' ? 0.15 : 0;
}

/** Freshness decay over a year (recent = higher). */
export function freshnessOf(freshness: string | null, now = Date.now()): number {
  if (!freshness) return 0;
  const t = new Date(freshness).getTime();
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (now - t) / 86_400_000);
  return 0.2 * (1 - Math.min(days, 365) / 365);
}

/** A reader gets a small authority boost for files in their own domain. */
export function authorityOf(domain: string, reader: Reader): number {
  return reader.domains.includes(domain) ? 0.1 : 0;
}

export type Ranked = Hit & { final: number; trust: number; freshnessBoost: number; authority: number };

/** Rerank fused hits by relevance + trust + freshness + authority; deterministic. */
export function rerank(hits: Hit[], reader: Reader, now = Date.now()): Ranked[] {
  return hits
    .map((h) => {
      const trust = trustOf(h.meta.tier);
      const freshnessBoost = freshnessOf(h.meta.freshness, now);
      const authority = authorityOf(h.meta.domain, reader);
      return { ...h, trust, freshnessBoost, authority, final: h.score + trust + freshnessBoost + authority };
    })
    .sort((a, b) => b.final - a.final || a.fileId.localeCompare(b.fileId));
}

const MEDIA = new Set(['image', 'video', 'audio']);

/** Package reranked hits into cited passages. `vision` only annotates that the raw
 *  original could go to STACKIT Qwen-VL when flagged — this build never calls it. */
export function toPassages(ranked: Ranked[], opts: { openOriginal?: boolean; visionFlag?: boolean } = {}): FilePassage[] {
  return ranked.map((h) => {
    const passage: FilePassage = {
      fileId: h.fileId,
      name: h.meta.name,
      repType: h.repType,
      snippet: h.text.length > 240 ? h.text.slice(0, 240) + '…' : h.text,
      deepLink: h.meta.deepLink,
      owner: h.meta.owner,
      domain: h.meta.domain,
      tier: h.meta.tier,
      freshness: h.meta.freshness,
      score: Number(h.final.toFixed(4)),
      trust: h.trust,
      freshnessBoost: Number(h.freshnessBoost.toFixed(4)),
      authority: h.authority,
    };
    if (opts.openOriginal && MEDIA.has(h.meta.kind)) {
      passage.openOriginal = { kind: h.meta.kind, deepLink: h.meta.deepLink, vision: opts.visionFlag ? 'flagged-stackit' : 'on-demand' };
    }
    return passage;
  });
}
