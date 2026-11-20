/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The data-runner adapter for Iceberg tags and branches (WP-37).
 * USER STORY: As a data owner I want a version name that the catalog refused, or a runner that is
 *             down, to show up as exactly that, with its reason, never as a name that was saved.
 * ARCHITECTURE:
 *   - `POST {DATA_RUNNER_URL}/refs` (images/extensions/data-runner/app.py `create_ref`): PyIceberg
 *     `manage_snapshots().create_tag/create_branch` committed to the Polaris REST catalog
 *     (https://py.iceberg.apache.org/api/#snapshot-management). Trino 476 has no tag DDL.
 *   - Returns the `Fetched` contract; never throws. The caller reads the result back from Trino.
 */
import { config } from '@core/kernel/config';
import { serviceBearerHeader } from '@core/infra/service-bearer';
import type { Fetched, FetchedFailure } from '@core/adapters/_contract';

export type RefRequest = {
  principal: string; uid: string; role: string; domains: string[];
  schema: string; table: string; kind: 'tag' | 'branch'; name: string; snapshotId: string;
};

const now = () => new Date().toISOString();
const fail = (reason: FetchedFailure, detail: string): Fetched<never> => ({ ok: false, reason, detail, at: now() });

export async function createIcebergRef(body: RefRequest, timeoutMs = 20_000): Promise<Fetched<{ table: string; name: string; snapshotId: string }>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${config.dataRunnerUrl}/refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceBearerHeader() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return fail(aborted ? 'timeout' : 'unreachable', `data-runner ${aborted ? 'timed out' : 'unreachable'} at ${config.dataRunnerUrl}/refs`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch((err) => `(body unreadable: ${String(err)})`);
  let data: { ok?: boolean; error?: string; table?: string; name?: string; snapshotId?: string } = {};
  try { data = JSON.parse(text); } catch { return fail('invalid', `data-runner /refs ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok || data.ok === false) {
    const reason: FetchedFailure = res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 409 ? 'conflict' : 'invalid';
    return fail(reason, data.error ?? `data-runner /refs ${res.status}`);
  }
  return { ok: true, value: { table: String(data.table ?? ''), name: String(data.name ?? ''), snapshotId: String(data.snapshotId ?? '') }, at: now() };
}
