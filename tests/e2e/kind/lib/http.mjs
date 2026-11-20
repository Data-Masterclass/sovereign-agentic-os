/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    One HTTP helper for every component client in the harness
 * USER STORY: As a harness author I want a failed request to surface as a typed HopError naming the
 *             component, so the report says "Trino unreachable", never "fetch failed".
 * ARCHITECTURE:
 *   - Global fetch (Node >= 22) with an AbortSignal timeout. Non-2xx is an error unless the caller
 *     lists the status in `okStatus`. The body is parsed as JSON when the response says so.
 */
import { HopError } from './hop.mjs';

export async function request(component, hop, url, { method = 'GET', headers = {}, body, timeoutMs = 20000, okStatus = [] } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HopError({ component, hop, reason: `unreachable: ${err.cause?.code ?? err.message}` });
  }
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  let data = text;
  if (isJson && text) {
    try { data = JSON.parse(text); } catch { throw new HopError({ component, hop, reason: `invalid JSON from ${url}` }); }
  }
  if (!res.ok && !okStatus.includes(res.status)) {
    throw new HopError({ component, hop, reason: `HTTP ${res.status}`, detail: typeof data === 'string' ? data.slice(0, 500) : data });
  }
  return { status: res.status, headers: res.headers, data, text };
}

export const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
