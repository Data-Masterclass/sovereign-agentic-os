/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Knowledge embeddings through the governed gateway, with an EXPLICIT, labelled fallback.
 * USER STORY: As a knowledge owner I never get an index of substitute vectors because my key was
 *             over budget or the model was not allowed — a rejection fails loudly, typed; only an
 *             unreachable or failing gateway degrades to the labelled offline hash so a laptop still
 *             works.
 * ARCHITECTURE:
 *   - LIVE: LiteLLM `/v1/embeddings` with the SCOPED credential (`callerCredential`, tab
 *     `knowledge`, the caller's domain) — never the master key (A3; checklist A25/A27).
 *   - FALLBACK RULE (checklist A31): a timeout, a transport error or a 5xx → the deterministic local
 *     hash embedding of the SAME dim, labelled `source: 'offline-hash'`. A 4xx (401 key, 403 model
 *     allowlist, 400 budget / malformed, 429) → `GatewayRejectedError` is THROWN; nothing is indexed.
 *   - The store is embedded AND queried through this one function, so live-vs-offline is consistent
 *     within a session (a model switch = a reindex). Deterministic path: opts into the gateway cache.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { roleModel } from '@core/models/roles';
import {
  callerCredential,
  GatewayRejectedError,
  isClientRejection,
  type CallerContext,
} from '@core/infra/litellm-credential';
import { hashEmbed } from '@tabs/knowledge/lib/embed-core';

export type EmbedResult = { vectors: number[][]; source: 'litellm' | 'offline-hash' };

/** The attribution an embedding call carries; defaults to the platform when no caller is known. */
export type EmbedCaller = Pick<CallerContext, 'userId' | 'domain' | 'tab' | 'keyRef'>;
const PLATFORM_CALLER: EmbedCaller = { userId: 'system', domain: 'platform', tab: 'knowledge' };

/**
 * The attribution for an index/embed triggered BY A USER (checklist A27). Pass it from any door
 * that has the acting user — the MCP tools and the routes — so LiteLLM bills that principal with
 * a `domain:` tag instead of `user os-system` + `domain:platform`. `domain` is the OBJECT's
 * domain, not the user's active one: the spend belongs to the knowledge/file being indexed.
 *
 * A door with no acting user (boot sweeps, a connector sync on a schedule) must pass NOTHING and
 * keep the platform attribution: that work really is the platform's, and inventing a user for it
 * would be a worse lie than the per-surface attribution A27 complained about.
 */
export function actingCaller(userId: string, domain: string): EmbedCaller {
  return { userId, domain, tab: 'knowledge' };
}

/** A transport-level outcome: a response, or `null` for a timeout / network failure. */
async function postEmbeddings(body: unknown, apiKey: string, ms = 4000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${config.litellmUrl}/v1/embeddings`, {
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

/**
 * Embed a batch of texts. Live through LiteLLM; a 4xx THROWS `GatewayRejectedError`; a timeout, a
 * transport failure, a 5xx or a malformed/mis-dimensioned reply falls back to the labelled hash.
 */
export async function embed(texts: string[], caller: EmbedCaller = PLATFORM_CALLER): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], source: 'offline-hash' };
  const cred = callerCredential({ ...caller, tab: caller.tab ?? 'knowledge' });
  // No scoped key configured: there is no live path to try (and the master key is not a fallback).
  const res = cred.apiKey
    ? await postEmbeddings({ model: roleModel('embeddings'), input: texts, user: cred.user, metadata: { tags: cred.tags }, cache: { 'use-cache': true } }, cred.apiKey)
    : null;

  if (res && isClientRejection(res.status)) {
    // A decision about THIS caller (key, allowlist, budget): never paper over it with substitutes.
    throw new GatewayRejectedError(res.status, await res.text().catch(() => ''));
  }
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
export async function embedQuery(text: string, caller: EmbedCaller = PLATFORM_CALLER): Promise<{ vector: number[]; source: EmbedResult['source'] }> {
  const { vectors, source } = await embed([text], caller);
  return { vector: vectors[0] ?? hashEmbed(text, config.embedDim), source };
}
