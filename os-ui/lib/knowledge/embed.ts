/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { roleModel } from '@/lib/models/roles';
import { hashEmbed } from './embed-core.ts';

/**
 * Embedding provider. LIVE path: the LiteLLM `sovereign-embed` model
 * (OpenAI-compatible `/v1/embeddings`, deterministic 384-dim on kind, real model
 * on STACKIT). OFFLINE path: a deterministic local hash embedding of the SAME dim,
 * so the index + retrieve pipeline works on a laptop with LiteLLM off. Mirrors the
 * dual pattern used across the OS (retrieveTool, guardrails-apply).
 *
 * The store is embedded AND queried through this one function, so live-vs-offline
 * is internally consistent within a single session (a model switch = a reindex).
 */

export type EmbedResult = { vectors: number[][]; source: 'litellm' | 'offline-hash' };

async function withTimeout(url: string, init: RequestInit, ms = 4000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Embed a batch of texts; live-try LiteLLM, fall back to the offline hash. */
export async function embed(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], source: 'offline-hash' };

  const res = await withTimeout(`${config.litellmUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.litellmMasterKey}` },
    body: JSON.stringify({ model: roleModel('embeddings'), input: texts }),
  });

  if (res && res.ok) {
    try {
      const data = (await res.json()) as { data?: { embedding?: number[] }[] };
      const rows = Array.isArray(data?.data) ? data.data : [];
      const vectors = rows.map((r) => (Array.isArray(r.embedding) ? r.embedding : []));
      // Only trust the live result if every row came back with the right dim.
      if (vectors.length === texts.length && vectors.every((v) => v.length === config.embedDim)) {
        return { vectors, source: 'litellm' };
      }
    } catch {
      /* fall through to offline */
    }
  }

  return { vectors: texts.map((t) => hashEmbed(t, config.embedDim)), source: 'offline-hash' };
}

/** Embed a single query string. */
export async function embedQuery(text: string): Promise<{ vector: number[]; source: EmbedResult['source'] }> {
  const { vectors, source } = await embed([text]);
  return { vector: vectors[0] ?? hashEmbed(text, config.embedDim), source };
}
