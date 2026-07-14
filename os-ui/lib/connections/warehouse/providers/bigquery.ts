/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Google BigQuery provider — FULLY implemented (Phase 1b). Trino native `bigquery`
 * connector, dataset federation billed against a (optionally distinct) parent project.
 *
 * KEY RULE — no credentials are ever inlined into the props. BigQuery auth has TWO
 * mutually-exclusive branches:
 *
 *   1. Service-account JSON (default when `credentialsSecretRef` is set) — the
 *      customer's SA key JSON is mounted as a FILE from a vault secret and referenced
 *      by path via `bigquery.credentials-file`. The JSON is NEVER inlined into the
 *      properties (Trino also supports `bigquery.credentials-key` as base64, which we
 *      deliberately DO NOT use — a file keeps the secret out of the rendered config).
 *
 *   2. Workload Identity (when `credentialsSecretRef` is omitted) — the Trino pod's
 *      GKE ServiceAccount is bound to a GCP service account, so the Google client
 *      library's Application Default Credentials resolve automatically. We emit NO
 *      `bigquery.credentials-file` line at all; there is no secret material to mount.
 *
 * The integration chart mounts the SA-JSON secret (key `bigquery-sa-json`) at
 * `/etc/trino/secrets/bq-sa.json` — the exact path emitted below.
 */

import {
  type BigQueryConfig,
  type WarehouseSource,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';

/**
 * Absolute path the integration chart mounts the customer's service-account JSON
 * secret at. Referenced BY PATH from the props (never inlined) in SA-JSON mode; in
 * Workload-Identity mode this file is absent and the line is omitted entirely.
 */
const BQ_CREDENTIALS_FILE = '/etc/trino/secrets/bq-sa.json';

/**
 * A source uses Workload Identity when it does NOT reference a service-account JSON
 * secret. In that branch GKE Workload Identity supplies the credentials and we emit
 * no `bigquery.credentials-file` line.
 */
function usesWorkloadIdentity(cfg: BigQueryConfig): boolean {
  return !cfg.credentialsSecretRef;
}

/**
 * BigQuery → Trino `bigquery` connector.
 *
 * Renders `project-id`, the optional `parent-project-id` (billing/parent project),
 * and — ONLY in service-account mode — a `credentials-file` path pointing at the
 * mounted SA-JSON. No JSON is ever inlined; Workload-Identity sources emit no
 * credentials line at all.
 */
function bigqueryProps(cfg: BigQueryConfig): TrinoCatalogProps {
  if (!cfg.projectId) {
    throw new WarehouseError(
      `bigquery: missing required projectId (GCP project that owns the datasets)`,
    );
  }

  const props: TrinoCatalogProps = {
    'connector.name': 'bigquery',
    'bigquery.project-id': cfg.projectId,
  };

  // Billing/parent project, only when distinct from the owning project.
  if (cfg.parentProjectId) {
    props['bigquery.parent-project-id'] = cfg.parentProjectId;
  }

  // Service-account mode: reference the mounted SA-JSON file BY PATH. Workload
  // Identity mode (no secret ref): emit nothing — ADC supplies the credentials.
  if (!usesWorkloadIdentity(cfg)) {
    props['bigquery.credentials-file'] = BQ_CREDENTIALS_FILE;
  }

  return props;
}

export const bigqueryProvider: WarehouseProvider = {
  platform: 'bigquery',
  label: 'Google BigQuery',
  trinoConnector: 'bigquery',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source: WarehouseSource) => bigqueryProps(source as BigQueryConfig),
  credentialFields: [
    {
      key: 'projectId',
      label: 'GCP project id',
      kind: 'text',
      required: true,
      help: 'Project that OWNS the datasets being federated, e.g. my-analytics-prod.',
    },
    {
      key: 'parentProjectId',
      label: 'Billing / parent project id',
      kind: 'text',
      required: false,
      help: 'Project that query jobs are billed to, if different from the owning project.',
    },
    {
      // Service-account JSON key. Required UNLESS the pod uses GKE Workload Identity,
      // in which case leave this blank and no secret is mounted.
      key: 'bigquery-sa-json',
      label: 'Service-account JSON key',
      kind: 'file-json',
      required: false,
      help: 'GCP service-account key JSON (roles/bigquery.dataViewer + jobUser). Mounted as a file, never inlined. Leave blank to use GKE Workload Identity.',
    },
  ],
  // The SA-JSON is mounted as a FILE (at BQ_CREDENTIALS_FILE), NOT exposed as an env
  // var — so `envVars` is empty. In Workload-Identity mode there is no secret at all,
  // but the key is still declared here so the deploy layer can mount it when present.
  secretMaterial: { secretKeys: ['bigquery-sa-json'], envVars: [] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'BigQuery',
    configKeys: ['project-id', 'credentials', 'databaseFilterPattern'],
  },
  // Prop rendering (both auth branches) is verified purely; the actual GCP path can
  // only be confirmed against a real project by the operator.
  liveVerificationRequired: [
    'Service-account JSON key validity (roles/bigquery.dataViewer + roles/bigquery.jobUser)',
    'Workload-Identity binding resolves the pod SA to a GCP service account',
    'Per-query bytes-scanned billing against the parent/billing project',
  ],
};
