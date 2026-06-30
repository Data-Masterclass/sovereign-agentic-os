/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../config.ts';

/**
 * The shared embedding step (deep-design A3 / B2 — the model fires once per chunk
 * at index time, once per query at search time). LIVE it calls the SHARED model
 * through LiteLLM (`/v1/embeddings`, model = `filesEmbedModel`: sovereign-embed@384
 * in kind, bge-m3@1024 via TEI on STACKIT). MOCK it returns a deterministic vector.
 *
 * CRITICAL invariant: the vector dimension is NEVER hardcoded — it comes from
 * `config.filesEmbedDim`, which the helm chart wires from `retrieval.knnDimension`
 * (the single source). Index-time and query-time use the SAME model + dim, so the
 * vectors are comparable. Same model at both ends = comparable vectors.
 *
 * Importable in unit tests (config has no `server-only`); only used server-side.
 */

export type EmbedResult = { vectors: number[][]; model: string; dim: number; mode: 'live' | 'mock' };

async function post(url: string, body: unknown, ms = 8000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.litellmMasterKey}` },
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
 * Embed a batch of texts. Tries the live LiteLLM endpoint; on any failure (kind /
 * model off) falls back to the deterministic mock at the SAME configured dim, so
 * index-time and query-time vectors always match. Returns the mode honestly.
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], model: config.filesEmbedModel, dim: config.filesEmbedDim, mode: 'mock' };
  const res = await post(`${config.litellmUrl}/v1/embeddings`, { model: config.filesEmbedModel, input: texts });
  if (res && res.ok) {
    try {
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      const data = json.data ?? [];
      if (data.length === texts.length && Array.isArray(data[0]?.embedding) && data[0].embedding.length > 0) {
        return { vectors: data.map((d) => d.embedding), model: config.filesEmbedModel, dim: data[0].embedding.length, mode: 'live' };
      }
    } catch {
      /* fall through to mock */
    }
  }
  return { vectors: texts.map((t) => mockEmbed(t)), model: config.filesEmbedModel, dim: config.filesEmbedDim, mode: 'mock' };
}

/** Embed a single query (deep-design B2). */
export async function embedQuery(text: string): Promise<{ vector: number[]; mode: 'live' | 'mock' }> {
  const r = await embedTexts([text]);
  return { vector: r.vectors[0] ?? mockEmbed(text), mode: r.mode };
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalised
}
