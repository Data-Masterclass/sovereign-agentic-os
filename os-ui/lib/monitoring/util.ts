/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
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
