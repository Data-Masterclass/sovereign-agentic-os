/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    dbt model planner — every OS dataset layer becomes a model, a source or an external asset
 * USER STORY: As a data engineer I want each Silver / Gold / sync landing the OS built for my domain
 *             to be a dbt model whose body is the governed projection the OS compiled, with
 *             `{{ ref() }}` between datasets and `{{ source() }}` at the governance boundary — so I
 *             can read the project and recognise my own practice (checklist D1, D4, D6, D13).
 * ARCHITECTURE:
 *   - Pure: `planModels(snapshot)` → models (name, path, schema, SQL), the sources they read, and
 *     the external assets dbt cannot express (Kafka offsets, API-batch sources — Dagster assets).
 *   - Bodies: the compiled CTAS `buildVersion` / `buildGoldJoin` recorded (today's `compileSilver`
 *     / `compileGoldJoin` output) with `create or replace table … as` stripped and every
 *     `iceberg.<schema>.<table>` rewritten — to `ref('<layer>_<slug>')` when the table is a model of
 *     THIS project (personal or domain copy), else `source('<schema>', '<table>')`. A built layer
 *     with no recorded body is a pass-through `select *` of the layer below (what `passThroughPlan`
 *     runs). Sync landings are incremental models: append = `delete+insert` on `_batch_id` with the
 *     late-data lookback predicate; merge = `merge` on the merge keys; full-refresh = `table`.
 *   - Lane model (concept §1): a personal (un-promoted) dataset's models live under
 *     `models/personal/<uid>/` with `+schema: personal_<uid>`; a promoted dataset's under
 *     `models/<layer>/` in the domain schema. Model name == physical table name, so FQNs hold.
 *   - Never throws on persisted data: an odd record degrades to a commented pass-through, so one
 *     bad dataset can never block a domain's commits.
 */
import type { Dataset, Layer, DatasetSync } from '@tabs/data/lib/dataset-schema';
import { physicalSlug, personalSchema, domainSchema, sanitizeIdent } from '@tabs/data/lib/store-fqn';
import { DEFAULT_LOOKBACK_MINUTES } from '@tabs/data/lib/sync-sql';
import { qident, qlit, stripJinja } from '@tabs/data/lib/dbt/emit';
import { columnDocs } from '@tabs/data/lib/dbt/schema';
import { freshnessMinutesFor } from '@tabs/data/lib/dbt/source-assets';
import type { ProjectSnapshot, SnapshotDataset } from '@tabs/data/lib/dbt/snapshot';

export type ModelKind = 'compiled' | 'pass-through' | 'sync-full-refresh' | 'sync-append' | 'sync-merge';

export type ModelPlan = {
  /** `<layer>_<slug>` — equals the physical table name. */
  name: string;
  /** `models/<layer>/<name>.sql` or `models/personal/<uid>/<name>.sql`. */
  path: string;
  /** The directory the model's `schema.yml` lives in. */
  dir: string;
  layer: Layer;
  kind: ModelKind;
  /** The physical schema this model materialises into (`personal_<uid>` or the domain schema). */
  schema: string;
  dataset: Dataset;
  /** Whether this model is the dataset's furthest layer (the one its checks test). */
  tested: boolean;
  /** The model file content (header, optional config block, body). */
  sql: string;
};

export type SourceTable = {
  /** dbt source name: the Iceberg schema, or `<catalog>__<schema>` for a federated table. */
  source: string;
  /** Trino catalog (dbt `database`). Absent when the connection's catalog could not be resolved. */
  database?: string;
  schema: string;
  table: string;
  description: string;
  /** The table carries `_loaded_at` (only then does `freshness` make sense). */
  loadedAt: boolean;
  meta?: Record<string, string>;
  /** Documented columns (+ `data_tests`) when the OS's quality rules attach to this source — the
   *  dataset's furthest layer was built out of band, so dbt tests it but never rewrites it. */
  columns?: Record<string, unknown>[];
};

export type ExternalAsset = {
  dataset: string;
  name: string;
  kind: 'kafka-offsets' | 'api-batch';
  connectionId: string;
  source: { schema: string; table: string };
  mode: DatasetSync['mode'];
  cron: string;
  enabled: boolean;
  principal: string;
  note: string;
};

/**
 * One FEDERATED source table a sync reads, as an OBSERVABLE Dagster asset (`os/sources.yml`,
 * engine rebuild B3). The asset key is `[<domain>, <source>, <table>]` — the key dagster-dbt
 * derives for the dbt source — so the silver model that reads it depends on this very node and the
 * lineage graph has no dangling edge. The Iceberg Bronze landing is deliberately NOT here: it lives
 * in the same lakehouse and carries `_loaded_at` source freshness instead.
 */
export type SourceAssetEntry = {
  source: string;
  table: string;
  database?: string;
  schema: string;
  dataset: string;
  principal: string;
  /** The model that reads this source (the sync landing) — the downstream edge. */
  model: string;
  mode: DatasetSync['mode'];
  observe: 'max_updated' | 'row_count';
  /** The timestamp cursor column `max_updated` probes. */
  updatedColumn?: string;
  cron: string;
  /** Minutes after which the source counts as late; null when the cron shape is unknown. */
  freshnessMinutes: number | null;
  enabled: boolean;
};

export type ModelPlanSet = {
  models: ModelPlan[];
  sources: SourceTable[];
  /** Federated sync sources as observable assets (`os/sources.yml`). */
  sourceAssets: SourceAssetEntry[];
  externals: ExternalAsset[];
  /** Sanitised uids that own personal-lane models (drives `+schema` in dbt_project.yml). */
  personalUids: string[];
  /** Layer directories present under `models/` (silver / gold / bronze). */
  layerDirs: Layer[];
};

const LAYER_ORDER: Layer[] = ['bronze', 'silver', 'gold'];
const FQN_RE = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
const CTAS_RE = /^\s*create\s+(?:or\s+replace\s+)?table\s+\S+\s+as\s+/i;

type SyncShape =
  | { kind: 'model'; layer: Layer; catalog: string | undefined }
  | { kind: 'external'; what: 'kafka-offsets' | 'api-batch' }
  | { kind: 'none' };

/** How a dataset's sync (if any) appears in the project. */
/**
 * The layer a sync physically LANDS in: a connected sync dataset lands its declared tier in the
 * domain schema; a warehouse-synced ingest dataset lands Bronze in the owner's personal lane.
 * Exported so the Dagster launcher records the run on the same layer the generator models.
 */
export function syncLandingLayer(d: Dataset): Layer {
  return d.connected && d.connected.mode === 'sync' ? d.connected.tier : 'bronze';
}

function syncShape(d: Dataset, catalogs: ProjectSnapshot['catalogs']): SyncShape {
  if (!d.sync) return { kind: 'none' };
  if (d.sync.cursor?.kind === 'kafka-offsets') return { kind: 'external', what: 'kafka-offsets' };
  const catalog = Object.prototype.hasOwnProperty.call(catalogs, d.sync.connectionId) ? catalogs[d.sync.connectionId] : undefined;
  if (catalog === null) return { kind: 'external', what: 'api-batch' };
  // A connected sync dataset lands its declared tier in the domain schema (`syncTargetFor`);
  // a warehouse-synced ingest dataset lands Bronze in the owner's personal lane.
  return { kind: 'model', layer: syncLandingLayer(d), catalog: catalog ?? undefined };
}

/** The schema the OS physically writes a layer of this dataset into. */
function schemaFor(d: Dataset, layer: Layer, sync: SyncShape): string {
  if (sync.kind === 'model' && sync.layer === layer) {
    return d.connected && d.connected.mode === 'sync' ? domainSchema(d.domain) : personalSchema(d.owner);
  }
  return d.tier === 'dataset' ? personalSchema(d.owner) : domainSchema(d.domain);
}

function modelDir(schema: string, layer: Layer): string {
  return schema.startsWith('personal_') ? `models/personal/${schema.slice('personal_'.length)}` : `models/${layer}`;
}

function header(d: Dataset, layer: Layer, name: string, extra: string[] = []): string[] {
  return [
    // dbt renders a model's SQL through Jinja, COMMENTS INCLUDED — so the authored name is made
    // inert before it is written (review B2-review-H3).
    `-- ${name} — ${layer} layer of OS dataset ${d.id} ("${stripJinja(d.name).replace(/\n/g, ' ')}", domain ${d.domain}).`,
    '-- Generated by Sovereign OS from the dataset definition; edit the dataset in the OS, not this file.',
    ...extra,
  ];
}

function sourceDescription(d: Dataset, what: string): string {
  return `${what} of OS dataset ${d.id} ("${stripJinja(d.name)}").`;
}

function hasLoadedAt(d: Dataset): boolean {
  return d.columns.some((c) => c.name === '_loaded_at');
}

/**
 * Rewrite every `catalog.schema.table` in a compiled body: a table that is a model of this project
 * → `{{ ref('<model>') }}`; anything else → `{{ source('<name>', '<table>') }}` (registered).
 */
export function rewriteFqns(
  body: string,
  modelByFqn: Map<string, string>,
  onSource: (s: { catalog: string; schema: string; table: string }) => string,
): string {
  return body.replace(FQN_RE, (whole, catalog: string, schema: string, table: string) => {
    const key = `${schema.toLowerCase()}.${table.toLowerCase()}`;
    if (catalog.toLowerCase() === 'iceberg' && modelByFqn.has(key)) return `{{ ref(${qlit(modelByFqn.get(key)!)}) }}`;
    const name = onSource({ catalog: catalog.toLowerCase(), schema: schema.toLowerCase(), table: table.toLowerCase() });
    return `{{ source(${qlit(name)}, ${qlit(table.toLowerCase())}) }}`;
  });
}

/** `create or replace table X as <select>` → `<select>`; anything else passes through. */
export function stripCtas(sql: string): string {
  return sql.replace(CTAS_RE, '').trim();
}

/** `delete+insert` / `merge` / `table` config for a sync landing. */
function syncModelSql(d: Dataset, sync: DatasetSync, sourceName: string, name: string): { sql: string; kind: ModelKind } {
  const src = `{{ source(${qlit(sourceName)}, ${qlit(sync.source.table)}) }}`;
  const head = header(d, 'bronze', name, [
    `-- Scheduled sync of ${sync.source.schema}.${sync.source.table} (${sync.mode}, cron "${sync.schedule.cron}" UTC) — see os/schedules.yml.`,
  ]);
  if (sync.mode === 'full-refresh') {
    return {
      kind: 'sync-full-refresh',
      sql: [...head, '', "{{ config(materialized='table', on_table_exists='replace') }}", '', `select * from ${src}`].join('\n'),
    };
  }
  const cursor = sync.cursor ? qident(sync.cursor.column) : null;
  const isTs = sync.cursor?.kind === 'timestamp';
  const lookback = isTs ? (sync.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) : 0;
  const lowerBound = cursor
    ? lookback > 0
      ? `(select max(${cursor}) from {{ this }}) - interval '${lookback}' minute`
      : `(select max(${cursor}) from {{ this }})`
    : null;
  const incremental = cursor
    ? ['{% if is_incremental() %}', `where ${cursor} > ${lowerBound}`, '{% endif %}']
    : ['-- no cursor recorded: every run re-reads the whole source (the OS store normally refuses this)'];
  if (sync.mode === 'merge') {
    const keys = (sync.mergeKeys ?? []).map((k) => qlit(k.replace(/'/g, ''))).join(', ');
    return {
      kind: 'sync-merge',
      sql: [
        ...head,
        `-- Late-data lookback: ${lookback} minute(s) re-delivered each run; merge absorbs the overlap by key.`,
        '',
        `{{ config(materialized='incremental', incremental_strategy='merge', unique_key=[${keys}], on_schema_change='append_new_columns') }}`,
        '',
        `select * from ${src}`,
        ...incremental,
      ].join('\n'),
    };
  }
  return {
    kind: 'sync-append',
    sql: [
      ...head,
      `-- Late-data lookback: ${lookback} minute(s) re-delivered each run. A RETRY that passes the same`,
      '-- --vars os_batch_id deletes and re-inserts exactly that slice (idempotent); a plain re-run defaults',
      '-- os_batch_id to invocation_id and DUPLICATES the lookback rows — the OS launcher passes the id on retry.',
      '',
      "{{ config(materialized='incremental', incremental_strategy='delete+insert', unique_key='_batch_id', on_schema_change='append_new_columns') }}",
      '',
      'select',
      '  *,',
      '  current_timestamp as _loaded_at,',
      `  '{{ var("os_batch_id", invocation_id) }}' as _batch_id`,
      `from ${src}`,
      ...incremental,
    ].join('\n'),
  };
}

type Registered = { d: SnapshotDataset; layer: Layer; name: string; schema: string; sync: SyncShape };

/** Plan every model, source and external asset of a domain snapshot. */
export function planModels(snap: ProjectSnapshot): ModelPlanSet {
  const datasets = [...snap.datasets].sort((a, b) => a.dataset.id.localeCompare(b.dataset.id));
  const taken = new Set<string>();
  const modelByFqn = new Map<string, string>();
  const registered: Registered[] = [];
  const externals: ExternalAsset[] = [];
  const sourceAssets: SourceAssetEntry[] = [];
  const sources = new Map<string, SourceTable>();
  const outOfBandByDataset = new Map<string, Layer[]>();

  const addSource = (s: SourceTable): string => {
    const key = `${s.source}::${s.table}`;
    if (!sources.has(key)) sources.set(key, s);
    return s.source;
  };

  // Pass 1 — names + the FQN → model map (bodies need the complete map).
  for (const entry of datasets) {
    const d = entry.dataset;
    if (d.connected && d.connected.mode === 'live') continue; // the external table IS the dataset
    const sync = syncShape(d, snap.catalogs);
    if (sync.kind === 'external' && d.sync) {
      externals.push({
        dataset: d.id,
        name: `${d.connected?.tier ?? 'bronze'}_${physicalSlug(d)}`,
        kind: sync.what,
        connectionId: d.sync.connectionId,
        source: { schema: d.sync.source.schema, table: d.sync.source.table },
        mode: d.sync.mode,
        cron: d.sync.schedule.cron,
        enabled: d.sync.enabled,
        principal: d.owner,
        note:
          sync.what === 'kafka-offsets'
            ? 'Per-partition Kafka offsets are not a dbt incremental model; a Dagster asset renders the OS kafkaAppendSql shape (B2).'
            : 'API-batch source (no Trino catalog); a Dagster external-source asset calls the governed slice executor (B2).',
      });
    }
    // Which built layers are MODELS: the sync landing, a pass-through the OS copied, or a body the
    // OS compiled (provenance recorded by the store). A built layer with an authored / unknown body
    // was materialised out of band: dbt reads it as a SOURCE and never rewrites it — a scheduled
    // `<model>+` run must not replace a user's table with a copy of the layer below (review M2).
    const compiled = new Set(entry.compiled ?? []);
    const layers: Layer[] = [];
    const outOfBand: Layer[] = [];
    if (sync.kind === 'model') layers.push(sync.layer);
    for (const layer of ['silver', 'gold'] as Layer[]) {
      if (layers.includes(layer)) continue;
      const v = d.versions[layer];
      if (!v.built) continue;
      const body = v.artifact ? entry.artifacts[v.artifact] : undefined;
      if (v.passThrough || (v.artifact && body && body.trim() && compiled.has(v.artifact))) layers.push(layer);
      else outOfBand.push(layer);
    }
    if (outOfBand.length) outOfBandByDataset.set(d.id, outOfBand);
    for (const layer of layers) {
      let name = `${layer}_${physicalSlug(d)}`;
      if (taken.has(name)) name = `${name}__${sanitizeIdent(d.id)}`; // two datasets, one slug (rename edge case)
      taken.add(name);
      const schema = schemaFor(d, layer, sync);
      modelByFqn.set(`${personalSchema(d.owner)}.${layer}_${physicalSlug(d)}`, name);
      modelByFqn.set(`${domainSchema(d.domain)}.${layer}_${physicalSlug(d)}`, name);
      registered.push({ d: entry, layer, name, schema, sync });
    }
  }

  // Pass 2 — bodies.
  const models: ModelPlan[] = [];
  const byDataset = new Map<string, Registered[]>();
  for (const r of registered) byDataset.set(r.d.dataset.id, [...(byDataset.get(r.d.dataset.id) ?? []), r]);

  const onSource = (d: Dataset) => (s: { catalog: string; schema: string; table: string }): string => {
    const name = s.catalog === 'iceberg' ? s.schema : `${s.catalog}__${s.schema}`;
    const own = s.catalog === 'iceberg' && s.schema === personalSchema(d.owner) && s.table === `bronze_${physicalSlug(d)}`;
    return addSource({
      source: name,
      database: s.catalog,
      schema: s.schema,
      table: s.table,
      description: own ? sourceDescription(d, 'Bronze landing (data-runner, PyIceberg — never written by dbt)') : `External table read by OS dataset ${d.id} ("${stripJinja(d.name)}").`,
      loadedAt: own ? hasLoadedAt(d) : false,
    });
  };

  for (const r of registered) {
    const d = r.d.dataset;
    const mine = byDataset.get(d.id)!;
    const furthest = [...mine].sort((a, b) => LAYER_ORDER.indexOf(b.layer) - LAYER_ORDER.indexOf(a.layer))[0];
    let sql: string;
    let kind: ModelKind;

    if (r.sync.kind === 'model' && r.sync.layer === r.layer && d.sync) {
      const catalog = r.sync.catalog;
      const sourceName = catalog ? `${catalog}__${d.sync.source.schema}` : `conn_${sanitizeIdent(d.sync.connectionId)}`;
      addSource({
        source: sourceName,
        ...(catalog ? { database: catalog } : {}),
        schema: d.sync.source.schema,
        table: d.sync.source.table,
        description: `Sync source of OS dataset ${d.id} ("${stripJinja(d.name)}") through connection ${d.sync.connectionId}.`,
        loadedAt: false,
        ...(catalog ? {} : { meta: { os_connection: d.sync.connectionId, os_catalog: 'unresolved' } }),
      });
      // The federated table becomes an OBSERVABLE asset (B3). Only when its catalog resolved: a
      // probe needs a real `catalog.schema.table` to query, and an unresolved connection has none.
      if (catalog) {
        const isTs = d.sync.cursor?.kind === 'timestamp';
        sourceAssets.push({
          source: sourceName,
          table: d.sync.source.table,
          database: catalog,
          schema: d.sync.source.schema,
          dataset: d.id,
          principal: d.owner,
          model: r.name,
          mode: d.sync.mode,
          observe: isTs ? 'max_updated' : 'row_count',
          ...(isTs && d.sync.cursor ? { updatedColumn: d.sync.cursor.column } : {}),
          cron: d.sync.schedule.cron,
          freshnessMinutes: freshnessMinutesFor(d.sync.schedule.cron),
          enabled: d.sync.enabled,
        });
      }
      ({ sql, kind } = syncModelSql(d, d.sync, sourceName, r.name));
    } else {
      const artifactPath = d.versions[r.layer].artifact;
      const body = artifactPath ? r.d.artifacts[artifactPath] : undefined;
      if (body && body.trim()) {
        const rewritten = rewriteFqns(stripCtas(body), modelByFqn, onSource(d));
        sql = [...header(d, r.layer, r.name), '', rewritten].join('\n');
        kind = 'compiled';
      } else {
        // Pass-through: the newest lower layer that exists in this project, else the Bronze source.
        const lower = r.layer === 'gold' ? mine.find((m) => m.layer === 'silver') : undefined;
        const bronzeModel = mine.find((m) => m.layer === 'bronze');
        const from = lower
          ? `{{ ref(${qlit(lower.name)}) }}`
          : bronzeModel
            ? `{{ ref(${qlit(bronzeModel.name)}) }}`
            : `{{ source(${qlit(addSource({
                source: personalSchema(d.owner),
                database: 'iceberg',
                schema: personalSchema(d.owner),
                table: `bronze_${physicalSlug(d)}`,
                description: sourceDescription(d, 'Bronze landing (data-runner, PyIceberg — never written by dbt)'),
                loadedAt: hasLoadedAt(d),
              }))}, ${qlit(`bronze_${physicalSlug(d)}`)}) }}`;
        const note = d.versions[r.layer].passThrough
          ? '-- Pass-through: this layer carries the layer below forward unchanged.'
          : '-- No compiled body was recorded for this layer; a pass-through of the layer below is assumed.';
        sql = [...header(d, r.layer, r.name, [note]), '', `select * from ${from}`].join('\n');
        kind = 'pass-through';
      }
    }

    models.push({
      name: r.name,
      path: `${modelDir(r.schema, r.layer)}/${r.name}.sql`,
      dir: modelDir(r.schema, r.layer),
      layer: r.layer,
      kind,
      schema: r.schema,
      dataset: d,
      // The furthest MODEL carries the tests — unless a higher layer was built out of band (then
      // the tests attach to that source below, where the data the OS checks actually lives).
      tested: furthest.name === r.name && !(outOfBandByDataset.get(d.id) ?? []).some((l) => LAYER_ORDER.indexOf(l) > LAYER_ORDER.indexOf(r.layer)),
      sql: sql.replace(/\n+$/, '') + '\n',
    });
  }

  // Out-of-band layers: declare the physical table as a source; the dataset's quality rules attach
  // to the furthest such layer as SOURCE tests (dbt build runs them) — never a model that would
  // rewrite a table the OS did not compile.
  for (const entry of datasets) {
    const d = entry.dataset;
    const layers = outOfBandByDataset.get(d.id);
    if (!layers?.length) continue;
    const furthestBuilt = [...LAYER_ORDER].reverse().find((l) => d.versions[l].built);
    for (const layer of layers) {
      const sync = syncShape(d, snap.catalogs);
      const schema = schemaFor(d, layer, sync);
      const table = `${layer}_${physicalSlug(d)}`;
      const tested = layer === furthestBuilt;
      const { columns, intentions } = columnDocs(d, tested);
      addSource({
        source: schema,
        database: 'iceberg',
        schema,
        table,
        description: sourceDescription(d, `${layer} layer built OUT OF BAND (authored body — dbt reads it, never rewrites it)`),
        loadedAt: false,
        meta: { os_dataset: d.id, os_layer: layer, os_built: 'out-of-band', ...(intentions.length ? { os_intentions: intentions.join('; ') } : {}) },
        ...(tested && columns.length ? { columns } : {}),
      });
    }
  }

  models.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const personalUids = [...new Set(models.filter((m) => m.schema.startsWith('personal_')).map((m) => m.schema.slice('personal_'.length)))].sort();
  const layerDirs = LAYER_ORDER.filter((l) => models.some((m) => m.dir === `models/${l}`));
  const sourceList = [...sources.values()].sort((a, b) => (a.source + '::' + a.table).localeCompare(b.source + '::' + b.table));
  externals.sort((a, b) => a.dataset.localeCompare(b.dataset));
  sourceAssets.sort((a, b) => `${a.source}::${a.table}`.localeCompare(`${b.source}::${b.table}`));
  return { models, sources: sourceList, sourceAssets, externals, personalUids, layerDirs };
}
