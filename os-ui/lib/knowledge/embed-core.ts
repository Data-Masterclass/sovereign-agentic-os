/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Pure embedding helpers for the OFFLINE path (no network). When the LiteLLM
 * `sovereign-embed` model is unreachable, the index/retrieve pipeline embeds with
 * this deterministic hashing-vectorizer at the SAME dimension (default 384), so
 * cosine ranking still works on a laptop with no cluster. It mirrors a
 * hashing-trick bag-of-tokens vectorizer: stable, dependency-free, and good enough
 * to rank a small knowledge base by lexical/semantic overlap in the demo.
 *
 * NOTE: these vectors are NOT interchangeable with the real model's — the offline
 * store is embedded AND queried with the same function, so the space is internally
 * consistent. (Switching to the real model means a reindex, as in production.)
 */

const DEFAULT_DIM = 384;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** FNV-1a hash → a stable non-negative integer for a token. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic, L2-normalized hashing embedding of `text` (offline mirror). */
export function hashEmbed(text: string, dim = DEFAULT_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const hh = hashToken(tok);
    const idx = hh % dim;
    // A second hash bit decides the sign (signed hashing trick → less collision bias).
    const sign = (hh & 0x10000) === 0 ? 1 : -1;
    v[idx] += sign;
  }
  // L2 normalize so dot product == cosine similarity.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/** Cosine similarity of two equal-length vectors (assumes L2-normalized → dot). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
