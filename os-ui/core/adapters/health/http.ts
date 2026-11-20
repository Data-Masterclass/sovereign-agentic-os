/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The HTTP read every component health() uses (design 00 §6).
 * USER STORY: As an operator I want a component that is down, slow or refusing to show exactly
 *             that reason on the Platform page — never an old version or a green light.
 * ARCHITECTURE:
 *   - `readHttp(url)` returns `Fetched<{status, text}>`: a transport error is `unreachable`, the
 *     timeout is `timeout`, 401/403 are `unauthorized`/`forbidden`, any other non-2xx is `invalid`
 *     with the status and the start of the body. Never throws.
 *   - `readJson(url)` parses on top of it; a body that is not JSON is `invalid`.
 *   - `promLabel(text, metric, label)` reads one label of one metric from a Prometheus text
 *     exposition (the Collector's `service_version`).
 */
import type { Fetched } from '../_contract';

export const HEALTH_TIMEOUT_MS = 3_000;

const now = () => new Date().toISOString();

export function failed<T>(reason: Extract<Fetched<T>, { ok: false }>['reason'], detail: string): Fetched<T> {
  return { ok: false, reason, detail, at: now() };
}

export function fetched<T>(value: T): Fetched<T> {
  return { ok: true, value, at: now() };
}

export type HttpRead = { status: number; text: string };

export async function readHttp(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Fetched<HttpRead>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: ctrl.signal, cache: 'no-store' });
    const text = await res.text();
    if (res.status === 401) return failed('unauthorized', `${url} answered 401`);
    if (res.status === 403) return failed('forbidden', `${url} answered 403`);
    if (res.status < 200 || res.status >= 300) return failed('invalid', `${url} answered ${res.status}: ${text.slice(0, 200)}`);
    return fetched({ status: res.status, text });
  } catch (e) {
    if (ctrl.signal.aborted) return failed('timeout', `${url} did not answer within ${init.timeoutMs ?? HEALTH_TIMEOUT_MS} ms`);
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    return failed('unreachable', `${url}: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function readJson<T = unknown>(url: string, init: Parameters<typeof readHttp>[1] = {}): Promise<Fetched<T>> {
  const r = await readHttp(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.value.text) as T, at: r.at };
  } catch {
    return failed('invalid', `${url} did not answer JSON: ${r.value.text.slice(0, 120)}`);
  }
}

/** One label value of the first sample of `metric` in a Prometheus text exposition. */
export function promLabel(text: string, metric: string, label: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${metric}{`)) continue;
    const m = line.match(new RegExp(`[{,]${label}="([^"]*)"`));
    if (m) return m[1];
  }
  return null;
}

/**
 * The version a VictoriaMetrics / VictoriaLogs binary states in the `app_version` label of its own
 * series. A release build (`victoria-metrics-20261106-175016-tags-v1.156.0-0-g0c1bf87a0c`) gives
 * its tag, `v1.156.0`; an enterprise build gives `v1.156.0-enterprise`. ANY other form (a
 * heads-master or custom build) is returned VERBATIM — never dropped, never "invalid" (WP-05
 * review #2). `null` only when the binary exports no `app_version` at all.
 */
export function vmVersion(text: string): string | null {
  const raw = text.match(/app_version="([^"]+)"/)?.[1];
  if (!raw) return null;
  return raw.match(/-tags-(v\d+\.\d+\.\d+(?:-[A-Za-z][A-Za-z0-9.]*)*)-\d+-g[0-9a-f]+$/)?.[1] ?? raw;
}
