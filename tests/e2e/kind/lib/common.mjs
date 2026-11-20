/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Shared journey vocabulary: principals, polling, trace ids, JWT payloads
 * USER STORY: As a journey author I want the test users and small utilities defined once, so
 *             every journey names the same people and waits the same way.
 * ARCHITECTURE:
 *   - PRINCIPALS are Keycloak usernames in the harness realm (WP-38 seeds them). Viewer V has
 *     attribute region=DE, W region=FR (09 F7).
 *   - createTraceId(seed) mirrors the Langfuse SDK's deterministic trace id: the first 32 hex
 *     characters of sha256(seed). Docs: https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing
 */
import { createHash } from 'node:crypto';
import { HopError } from './hop.mjs';

export const DOMAIN = 'sales';
export const OTHER_DOMAIN = 'marketing';
export const PRINCIPALS = {
  U: 'u123',            // creator in sales
  OTHER: 'u999',        // creator in marketing (must see nothing of sales' My/Domain files)
  A: 'a-domain-admin',  // domain_admin of sales
  B: 'b-builder',       // builder in sales
  C: 'c-admin',         // tenant admin
  S2: 'u124',           // second sales member (AT-e)
  V: 'v-viewer-de',     // viewer, region=DE
  W: 'w-viewer-fr',     // viewer, region=FR
};

export const createTraceId = (seed) => createHash('sha256').update(seed).digest('hex').slice(0, 32);

export function jwtPayload(token) {
  const part = String(token).replace(/^Bearer\s+/i, '').split('.')[1];
  if (!part) return null;
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** Poll fn until it returns a truthy value; HopError with `what` after timeoutMs. */
export async function waitFor(fn, { component, hop, what, timeoutMs = 300000, everyMs = 3000 }) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
      if (err instanceof HopError && /unreachable|absent|no .* in the install/.test(err.reason)) throw err;
    }
    if (Date.now() > until) {
      throw new HopError({ component, hop, reason: `${what} not seen within ${Math.round(timeoutMs / 1000)} s${last ? ` (last error: ${last.reason ?? last.message})` : ''}` });
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const isoNow = () => new Date().toISOString();
