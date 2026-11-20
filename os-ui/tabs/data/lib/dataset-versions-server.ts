/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The governed wiring of dataset versions (WP-37): the same calls the Data tab's
 *             version panel and the MCP version tools make.
 * USER STORY: As a data owner I want the versions I see, compare, restore and name to be read and
 *             written as ME, through the same governed path as every other data access.
 * ARCHITECTURE:
 *   - Reads: `queryRun` as the viewer's principal (Trino → OPA governs `$snapshots`, `$refs` and
 *     every `FOR VERSION AS OF` read). Restore: `executeRun` (the approved-write path, which admits
 *     `rollback_to_snapshot` with a literal id and applies the same schema/role floor as any write).
 *   - Tags and branches: data-runner `POST /refs` (PyIceberg → Polaris `set-snapshot-ref`), after
 *     the OS edit gate here; Trino 476 has no statement that creates a ref.
 *   - The dataset → table rule (one dataset, its own table, never a shared one) is in
 *     `dataset-versions.ts`; this file only supplies the side effects.
 */
import 'server-only';
import { queryRun, executeRun } from '@core/infra/governed';
import { routeForTable } from '@core/infra/trino-source';
import { serviceBearerHeader } from '@core/infra/service-bearer';
import { config } from '@core/kernel/config';
import type { Role } from '@core/kernel/session';
import { getDataset, listAllDatasets, requireDatasetEditable, type Principal } from '@tabs/data/lib/store';
import type { Layer } from '@tabs/data/lib/dataset-schema';
import {
  diffVersions, listVersions, nameVersion, rollbackVersion,
  type DatasetDiff, type DatasetVersions, type VersionDeps,
} from '@tabs/data/lib/dataset-versions';

const SURFACE = 'data-versions';

function depsFor(user: Principal): VersionDeps {
  return {
    query: async (sql, principal, fqn) => {
      const r = await queryRun(sql, principal, routeForTable(fqn, SURFACE, user.domains));
      return { rows: r.rows, columns: r.columns };
    },
    execute: async (sql, who, fqn) => {
      await executeRun(sql, { principal: who.principal, uid: who.uid, domains: who.domains, role: who.role as Role }, routeForTable(fqn, SURFACE, user.domains));
    },
    createRef: async (body) => {
      const res = await fetch(`${config.dataRunnerUrl}/refs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...serviceBearerHeader() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let data: { ok?: boolean; error?: string } = {};
      try { data = JSON.parse(text); } catch { throw new Error(`data-runner returned non-JSON: ${text.slice(0, 200)}`); }
      if (!res.ok || data.ok === false) throw new Error(data.error ?? `data-runner /refs ${res.status}`);
    },
  };
}

const everyDataset = () => listAllDatasets({ includeArchived: true });

/** The dataset's versions, read as the viewer (view-scoped: `getDataset` refuses what they cannot see). */
export function datasetVersionsLive(id: string, user: Principal, layer?: Layer): Promise<DatasetVersions> {
  return listVersions(getDataset(id, user), user, everyDataset(), depsFor(user), layer);
}

/** The data diff between two versions (snapshot ids or tag/branch names). */
export function diffDatasetDataLive(
  id: string, user: Principal, input: { from: unknown; to: unknown; layer?: Layer; limit?: number },
): Promise<DatasetDiff> {
  return diffVersions(getDataset(id, user), user, everyDataset(), depsFor(user), input);
}

/** Restore: make an earlier snapshot current (edit-scoped). */
export function rollbackDatasetLive(id: string, user: Principal, input: { snapshotId: unknown; layer?: Layer }) {
  return rollbackVersion(requireDatasetEditable(id, user), user, everyDataset(), depsFor(user), input);
}

/** Name a version as a tag (kept by every expiry) or a branch (edit-scoped). */
export function nameDatasetVersionLive(
  id: string, user: Principal, input: { snapshotId: unknown; name: unknown; kind?: 'tag' | 'branch'; layer?: Layer },
) {
  return nameVersion(requireDatasetEditable(id, user), user, everyDataset(), depsFor(user), input);
}
