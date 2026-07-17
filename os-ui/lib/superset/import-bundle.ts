/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { zipBundle } from './zip.ts';

/**
 * Turn the OS's dashboard JSON manifest (the same shape produced by
 * `lib/dashboards/model.ts#supersetBundle` and `lib/data/metrics.ts#scaffoldDashboardBundle`)
 * into a REAL Superset `import_assets` ZIP: `metadata.yaml` + `databases/` + `datasets/`
 * + `charts/` + `dashboards/` YAML, which `POST /api/v1/dashboard/import/` accepts as
 * multipart form-data. (The previous code discarded the bundle and POSTed a JSON
 * `{dashboard_title}` body, which Superset rejects — so no dashboard was ever created.)
 *
 * Object identities are deterministic UUIDv5 derived from the dashboard title +
 * dataset/chart names, so re-importing the same dashboard is idempotent (Superset
 * matches existing objects by uuid) rather than piling up duplicates. Charts reference
 * the dataset by `dataset_uuid`; the dataset references the database by `database_uuid`;
 * the dashboard `position` references each chart by `meta.uuid` — the linkage Superset's
 * importer needs to wire the assets together.
 */

export type ManifestChart = { name: string; viz_type?: string; metric?: string; groupby?: string[] };
export type SupersetManifest = {
  dashboard: string;
  database_service_name?: string;
  dataset: { name: string; schema?: string; sql?: string };
  charts: ManifestChart[];
};

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC-4122 DNS namespace

/** Deterministic UUIDv5 (SHA-1 over namespace+name). Stable per logical name ⇒ import
 *  is idempotent: Superset upserts by uuid instead of creating duplicates. */
export function uuid5(name: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}

/** Parse + validate the JSON manifest. Throws (⇒ adapter ✗) on a malformed bundle. */
export function parseManifest(bundle: string): SupersetManifest {
  const d = JSON.parse(bundle) as Partial<SupersetManifest>;
  if (!d || typeof d.dashboard !== 'string' || !d.dashboard.trim()) throw new Error('manifest: missing dashboard title');
  if (!d.dataset || typeof d.dataset.name !== 'string' || !d.dataset.name.trim()) throw new Error('manifest: missing dataset');
  if (!Array.isArray(d.charts) || d.charts.length === 0) throw new Error('manifest: dashboard needs at least one chart');
  return {
    dashboard: d.dashboard,
    database_service_name: d.database_service_name ?? 'trino',
    dataset: { name: d.dataset.name, schema: d.dataset.schema ?? 'cube', sql: d.dataset.sql ?? `SELECT * FROM "${d.dataset.name}"` },
    charts: d.charts.map((c) => ({ name: c.name, viz_type: c.viz_type ?? 'table', metric: c.metric, groupby: c.groupby ?? [] })),
  };
}

const ROOT = 'dashboard_export';

/** Build the { path → YAML } file map of a Superset import_assets bundle for the manifest. */
export function importFiles(manifest: SupersetManifest): Record<string, string> {
  const dbName = manifest.database_service_name || 'trino';
  const dbUuid = uuid5(`database:${dbName}`);
  const dsUuid = uuid5(`dataset:${dbName}:${manifest.dataset.name}`);
  const dashUuid = uuid5(`dashboard:${manifest.dashboard}`);

  const charts = manifest.charts.map((c, i) => ({
    ...c,
    uuid: uuid5(`chart:${manifest.dashboard}:${c.name}:${i}`),
    file: `${slug(c.name)}_${i + 1}`,
  }));

  const files: Record<string, string> = {};

  files[`${ROOT}/metadata.yaml`] = yaml.dump({
    version: '1.0.0',
    type: 'Dashboard',
    timestamp: '1980-01-01T00:00:00+00:00',
  });

  files[`${ROOT}/databases/${slug(dbName)}.yaml`] = yaml.dump({
    database_name: dbName,
    sqlalchemy_uri: `${dbName}://${dbName}@${dbName}:8080/iceberg`,
    cache_timeout: null,
    expose_in_sqllab: true,
    allow_ctas: false,
    allow_cvas: false,
    allow_dml: false,
    allow_file_upload: false,
    // Superset's ImportV1DatabaseExtraSchema is a NESTED schema — `extra` MUST be a
    // YAML object, not a JSON string ('{}' makes its pre_load call .get() on a str →
    // 500 on import). An empty object satisfies the (all-optional) extra schema.
    extra: {},
    uuid: dbUuid,
    version: '1.0.0',
  });

  files[`${ROOT}/datasets/${slug(dbName)}/${slug(manifest.dataset.name)}.yaml`] = yaml.dump({
    table_name: manifest.dataset.name,
    main_dttm_col: null,
    description: null,
    default_endpoint: null,
    offset: 0,
    cache_timeout: null,
    schema: manifest.dataset.schema ?? 'cube',
    sql: manifest.dataset.sql,
    params: null,
    template_params: null,
    filter_select_enabled: true,
    fetch_values_predicate: null,
    extra: null,
    normalize_columns: false,
    always_filter_main_dttm: false,
    uuid: dsUuid,
    metrics: [],
    columns: [],
    version: '1.0.0',
    database_uuid: dbUuid,
  });

  for (const c of charts) {
    files[`${ROOT}/charts/${c.file}.yaml`] = yaml.dump({
      slice_name: c.name,
      viz_type: c.viz_type,
      // Superset's chart import schema wants `params` as a MAPPING (object), not a
      // JSON string ("Not a valid mapping type." otherwise).
      params: {
        viz_type: c.viz_type,
        datasource: `${dsUuid}__table`,
        metric: c.metric ?? null,
        metrics: c.metric ? [c.metric] : [],
        groupby: c.groupby ?? [],
      },
      query_context: null,
      cache_timeout: null,
      uuid: c.uuid,
      version: '1.0.0',
      dataset_uuid: dsUuid,
    });
  }

  // Position: ROOT → GRID → a ROW of CHART nodes; each CHART links its slice by meta.uuid.
  const position: Record<string, unknown> = {
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { type: 'ROOT', id: 'ROOT_ID', children: ['GRID_ID'] },
    GRID_ID: { type: 'GRID', id: 'GRID_ID', parents: ['ROOT_ID'], children: ['ROW-1'] },
    'ROW-1': { type: 'ROW', id: 'ROW-1', parents: ['ROOT_ID', 'GRID_ID'], meta: { background: 'BACKGROUND_TRANSPARENT' }, children: charts.map((c) => `CHART-${c.uuid}`) },
  };
  for (const c of charts) {
    position[`CHART-${c.uuid}`] = {
      type: 'CHART',
      id: `CHART-${c.uuid}`,
      parents: ['ROOT_ID', 'GRID_ID', 'ROW-1'],
      children: [],
      meta: { uuid: c.uuid, width: 4, height: 50, sliceName: c.name, chartId: 0 },
    };
  }

  files[`${ROOT}/dashboards/${slug(manifest.dashboard)}.yaml`] = yaml.dump({
    dashboard_title: manifest.dashboard,
    description: null,
    css: '',
    slug: null,
    certified_by: null,
    certification_details: null,
    published: true,
    uuid: dashUuid,
    position,
    metadata: {
      color_scheme: null,
      cross_filters_enabled: true,
      native_filter_configuration: [],
    },
    version: '1.0.0',
  });

  return files;
}

/** Full pipeline: JSON manifest string → Superset import_assets ZIP bytes. */
export function buildImportZip(bundle: string): Uint8Array {
  return zipBundle(importFiles(parseManifest(bundle)));
}
