/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ONLY module that can change LiteLLM. One `adminPost`, so
 *             every write to the gateway goes through one audited door.
 *
 * USER STORY: As a reviewer I can answer "what in the OS can modify the model
 *             gateway?" by looking at who imports this file — the answer is a
 *             file-level fact, not a code-reading exercise.
 *             As a platform admin, a write that fails tells me which operation
 *             failed and why, instead of leaving the gateway half-changed with
 *             no record.
 *
 * ARCHITECTURE:
 *   Deliberately separate from `litellm-admin.ts`, which is read-only. The
 *   split is the point: `ARCHITECTURE.md` promises that "we observe the
 *   gateway" and "we change the gateway" are separable by a reviewer, and two
 *   files is how that promise is kept.
 *
 *   Writes go to LiteLLM's ADMIN API, never to its config file or its Postgres.
 *   That is what makes them appear in LiteLLM's own UI: an admin who looks at
 *   the gateway directly sees exactly what the OS created, with the same
 *   aliases and budgets, rather than a divergent shadow configuration.
 *
 *   Uses the MASTER key, which is correct here: these calls administer the
 *   gateway itself. The master key must never reach a RUN path — that is
 *   `litellm-credential.ts`, and the `MODEL-KEY` gate test enforces it.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { DEFAULT_TIMEOUT_MS, liteLlmConfigured, type Fetched } from '@core/infra/litellm-admin';

/**
 * POST one LiteLLM admin path. Like the read client it returns a result rather
 * than throwing, because a reconcile run must report every failed operation
 * instead of aborting on the first one and leaving the rest unattempted.
 */
export async function adminPost<T>(
  path: string,
  body: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Fetched<T>> {
  if (!liteLlmConfigured()) return { ok: false, error: 'LiteLLM is not configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.litellmUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.litellmMasterKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
    } catch {
      // A 2xx with a non-JSON body still succeeded; the body is not load-bearing.
      return { ok: true, data: {} as T };
    }
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || 'fetch failed') };
  } finally {
    clearTimeout(timer);
  }
}
