/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    MCP tools for a dataset's DATA versions (WP-37): list, diff, restore, name.
 * USER STORY: As an agent or engineer I want to see a dataset's versions, compare two, restore one
 *             and pin one by name, through the same governed calls as the Data tab.
 * ARCHITECTURE:
 *   - Thin wrappers over `dataset-versions-server.ts`, the same functions the version route calls.
 *   - A version is an Iceberg snapshot id; a name is an Iceberg tag or branch. Plain Trino reads the
 *     same: `SELECT * FROM "<t>$snapshots"`, `"<t>$refs"`, `… FOR VERSION AS OF '<tag>'`.
 *   - `get_version` / `diff_versions` keep their contract: they read the DEFINITION from git.
 *     These tools read the DATA from Iceberg; neither stores a version record of its own.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { P, fail, str } from '@core/mcp/write-common';
import type { Layer } from '@tabs/data/lib/dataset-schema';
import {
  datasetVersionsLive, diffDatasetDataLive, nameDatasetVersionLive, rollbackDatasetLive,
} from '@tabs/data/lib/dataset-versions-server';

const LAYER = { type: 'string', enum: ['bronze', 'silver', 'gold'], description: 'Medallion layer; default: the layer the dataset is served from.' } as const;
const layerOf = (v: unknown): Layer | undefined => (v === 'bronze' || v === 'silver' || v === 'gold' ? v : undefined);
function id(args: Record<string, unknown>, tool: string): string {
  const v = str(args.datasetId).trim();
  if (!v) fail(`${tool} needs a \`datasetId\``, 400);
  return v;
}

export const datasetVersionReadTools: McpTool[] = [
  {
    name: 'get_dataset_versions',
    tab: 'data',
    minRole: 'creator',
    description:
      'List the DATA versions of a dataset: its Iceberg table’s snapshots, newest first, each with its commit time, operation, row counts and the tags/branches on it; `current` is the snapshot the table reads now. Read as YOU from the table’s own `$snapshots` and `$refs` — the OS stores no version record. Before: get_dataset. After: diff_dataset_data, rollback_dataset_version, tag_dataset_version. For the dataset’s DEFINITION history use get_history/get_version/diff_versions (git). Refusals: `shared_table` when another dataset (archived included) maps to the same table — its history is not this dataset’s alone; `not_built` when there is no table yet.',
    inputSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string', description: 'Dataset id.' }, layer: LAYER },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd' }, { datasetId: 'ds_ab12cd', layer: 'silver' }],
    },
    call: async (user, args) => datasetVersionsLive(id(args, 'get_dataset_versions'), P(user), layerOf(args.layer)),
  },
  {
    name: 'diff_dataset_data',
    tab: 'data',
    minRole: 'creator',
    description:
      'Compare the DATA of two versions of a dataset: `added` rows (in `to`, not in `from`) and `removed` rows, counted as multisets with `EXCEPT ALL` over two Iceberg time-travel reads (`FOR VERSION AS OF`), plus up to `limit` example rows marked `+`/`-`. A version is a snapshot id or a tag/branch name from get_dataset_versions. Read as YOU. An updated row shows as one removed plus one added. Schema changes between the versions make the comparison fail with Trino’s own error.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id.' },
        from: { type: 'string', description: 'Older version: snapshot id or tag/branch name.' },
        to: { type: 'string', description: 'Newer version: snapshot id or tag/branch name.' },
        layer: LAYER,
        limit: { type: 'number', description: 'Example rows per side (default 50, max 1000).' },
      },
      required: ['datasetId', 'from', 'to'],
      examples: [{ datasetId: 'ds_ab12cd', from: 'promoted-ap_12', to: '8954597067493422955' }],
    },
    call: async (user, args) =>
      diffDatasetDataLive(id(args, 'diff_dataset_data'), P(user), { from: args.from, to: args.to, layer: layerOf(args.layer), limit: typeof args.limit === 'number' ? args.limit : undefined }),
  },
];

export const datasetVersionWriteTools: McpTool[] = [
  {
    name: 'rollback_dataset_version',
    tab: 'data',
    minRole: 'creator',
    description:
      'Restore a dataset’s data to an earlier version: Iceberg’s own `ALTER TABLE … EXECUTE rollback_to_snapshot(<id>)` on the dataset’s table, through the governed write path (your own lane, or your domain as a builder+). Nothing is deleted: the newer snapshots stay in the history until expiry, so a restore can itself be undone by rolling forward. Refused on a table another dataset maps to (`shared_table`, archived siblings included) and on a legacy name-only lane table (`legacy_lane`); the refusal touches nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id you can edit.' },
        snapshotId: { type: 'string', description: 'The snapshot id to make current (from get_dataset_versions).' },
        layer: LAYER,
      },
      required: ['datasetId', 'snapshotId'],
      examples: [{ datasetId: 'ds_ab12cd', snapshotId: '8954597067493422955' }],
    },
    call: async (user, args) => rollbackDatasetLive(id(args, 'rollback_dataset_version'), P(user), { snapshotId: args.snapshotId, layer: layerOf(args.layer) }),
  },
  {
    name: 'tag_dataset_version',
    tab: 'data',
    minRole: 'creator',
    description:
      'Name a version of a dataset’s data: an Iceberg TAG (immutable; kept by every snapshot expiry, whatever the retention) or a BRANCH, committed to the Polaris catalog. Any engine then reads it by name: `SELECT * FROM <table> FOR VERSION AS OF \'<name>\'` and lists it in `"<table>$refs"`. Names: letters, digits, `.`, `_`, `-` (not `main`); a taken name is refused, never moved. Same edit gate and shared-table refusal as rollback_dataset_version.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id you can edit.' },
        snapshotId: { type: 'string', description: 'The snapshot id to name.' },
        name: { type: 'string', description: 'Tag or branch name.' },
        kind: { type: 'string', enum: ['tag', 'branch'], description: 'Default tag.' },
        layer: LAYER,
      },
      required: ['datasetId', 'snapshotId', 'name'],
      examples: [{ datasetId: 'ds_ab12cd', snapshotId: '8954597067493422955', name: 'q3-close' }],
    },
    call: async (user, args) =>
      nameDatasetVersionLive(id(args, 'tag_dataset_version'), P(user), {
        snapshotId: args.snapshotId, name: args.name, kind: args.kind === 'branch' ? 'branch' : 'tag', layer: layerOf(args.layer),
      }),
  },
];
