/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Files embeddings through the governed gateway, with an EXPLICIT, labelled fallback.
 * USER STORY: As a Files owner my index never silently fills with mock vectors because the key was
 *             over budget or the model disallowed — a rejection fails loudly, typed; only an
 *             unreachable or failing gateway degrades to the labelled deterministic mock.
 * ARCHITECTURE:
 *   - LIVE: LiteLLM `/v1/embeddings` (model = the Embeddings role) with the SCOPED credential
 *     (`callerCredential`, tab `files`) — never the master key (A3; checklist A25/A27).
 *   - FALLBACK RULE (checklist A31): timeout / transport error / 5xx / dim mismatch → the
 *     deterministic mock at the SAME configured dim, labelled `mode: 'mock'`. A 4xx → the typed
 *     `GatewayRejectedError` is THROWN; nothing is indexed.
 *   - CRITICAL invariant: the vector dimension is NEVER hardcoded — `config.filesEmbedDim`, wired by
 *     the chart from `retrieval.knnDimension`. Index-time and query-time use the SAME model + dim.
 *   - Importable in unit tests (config has no `server-only`); only used server-side.
 */
import { config } from '@core/kernel/config';
import { roleModel } from '@core/models/roles';
import {
  callerCredential,
  GatewayRejectedError,
  isClientRejection,
  type CallerContext,
} from '@core/infra/litellm-credential';

export type EmbedResult = { vectors: number[][]; model: string; dim: number; mode: 'live' | 'mock' };

/** The attribution an embedding call carries; defaults to the platform when no caller is known. */
export type EmbedCaller = Pick<CallerContext, 'userId' | 'domain' | 'tab' | 'keyRef'>;
const PLATFORM_CALLER: EmbedCaller = { userId: 'system', domain: 'platform', tab: 'files' };

async function post(url: string, body: unknown, apiKey: string, ms = 8000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Deterministic mock embedding: a unit-norm vector of `dim` (from config) seeded
 *  from the text, so the same text always embeds identically (cache-stable) and
 *  similar texts share leading components for a usable cosine in kind. */
export function mockEmbed(text: string, dim = config.filesEmbedDim): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (Math.imul(31, h) + tok.charCodeAt(i)) | 0;
    const idx = (h >>> 0) % dim;
    v[idx] += 1;
  }
  // L2-normalise so cosine = dot product.
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Embed a batch of texts. Live through LiteLLM; a 4xx THROWS `GatewayRejectedError`; a timeout, a
 * transport failure, a 5xx or a dim mismatch falls back to the deterministic mock at the SAME dim,
 * labelled `mode: 'mock'`, so index-time and query-time vectors always match.
 */
export async function embedTexts(texts: string[], caller: EmbedCaller = PLATFORM_CALLER): Promise<EmbedResult> {
  // The embeddings ROLE selects the live model_name (admin override else the
  // sovereign-embed env default). The vector dim stays config.filesEmbedDim — the
  // helm-wired single source that MUST match the model behind the alias.
  const model = roleModel('embeddings');
  const dim = config.filesEmbedDim;
  if (texts.length === 0) return { vectors: [], model, dim, mode: 'mock' };
  const cred = callerCredential({ ...caller, tab: caller.tab ?? 'files' });
  const res = cred.apiKey
    ? await post(`${config.litellmUrl}/v1/embeddings`, { model, input: texts, user: cred.user, metadata: { tags: cred.tags }, cache: { 'use-cache': true } }, cred.apiKey)
    : null;
  if (res && isClientRejection(res.status)) {
    // A decision about THIS caller (key, allowlist, budget): never paper over it with substitutes.
    throw new GatewayRejectedError(res.status, await res.text().catch(() => ''));
  }
  if (res && res.ok) {
    try {
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      const data = json.data ?? [];
      // Only trust the live result if EVERY row came back at the index's configured
      // dimension. The `files` knn_vector field is mapped at `config.filesEmbedDim`;
      // a live vector of any other length is REJECTED by OpenSearch at write time and
      // can never match a query vector — so a dim mismatch (a mis-pointed alias) must
      // fall back to the deterministic mock at the correct dim, never silently index
      // un-searchable rows. Mirrors the knowledge `embed.ts` dim guard.
      if (
        data.length === texts.length &&
        data.every((d) => Array.isArray(d?.embedding) && d.embedding.length === dim)
      ) {
        return { vectors: data.map((d) => d.embedding), model, dim, mode: 'live' };
      }
    } catch {
      /* fall through to mock */
    }
  }
  return { vectors: texts.map((t) => mockEmbed(t)), model, dim, mode: 'mock' };
}

/** Embed a single query (deep-design B2). */
export async function embedQuery(text: string, caller: EmbedCaller = PLATFORM_CALLER): Promise<{ vector: number[]; mode: 'live' | 'mock' }> {
  const r = await embedTexts([text], caller);
  return { vector: r.vectors[0] ?? mockEmbed(text), mode: r.mode };
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalised
}
