/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring read helper — a fetch with a timeout that never throws
 * USER STORY: As a Monitoring adapter author I want a down backend to resolve to `null` so that
 *             one unreachable service never breaks the whole overview.
 * ARCHITECTURE:
 *   - Server-only; used by `adapters/run-trace.ts` and `adapters/agent-telemetry.ts`.
 *   - Aborts after `ms` (default 2500) and sends `cache: 'no-store'`.
 */
import 'server-only';

/**
 * One read-only fetch helper for every adapter: aborts on timeout and NEVER
 * throws (a down backend resolves `null` so the adapter falls back to its
 * offline mock). Monitoring only ever READS — no method other than GET/POST-read
 * is used, and no adapter mutates any source.
 */
export async function readFetch(
  url: string,
  init: RequestInit = {},
  ms = 2500,
): Promise<Response | null> {
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
