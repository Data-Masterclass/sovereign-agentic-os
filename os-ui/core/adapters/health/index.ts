/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one table of component health() functions (design 00 §6, CI rule GLUE-4).
 * USER STORY: As an operator I want every version on the Platform page to be what the component
 *             itself reports, so a version can never drift from what is deployed.
 * ARCHITECTURE: keyed by the Platform registry id (tabs/admin/lib/platform.ts). A component not in
 *   this table has no version endpoint; the Platform page shows its running pod's image tag
 *   instead and labels it as such.
 */
import type { ComponentHealth, Fetched } from '../_contract';
import { dagsterHealth } from '../dagster/health';
import { doclingHealth } from '../docling/health';
import { langfuseHealth } from '../langfuse/health';
import { litellmHealth } from '../litellm/health';
import { opaHealth } from '../opa/health';
import { opensearchHealth } from '../opensearch/health';
import { otelCollectorHealth } from '../otel-collector/health';
import { postgresHealth } from '../postgres/health';
import { trinoHealth } from '../trino/health';
import { victoriaLogsHealth } from '../victoria-logs/health';
import { victoriaMetricsHealth } from '../victoria-metrics/health';

export type HealthFn = () => Promise<Fetched<ComponentHealth>>;

export const COMPONENT_HEALTH: Readonly<Record<string, HealthFn>> = {
  trino: () => trinoHealth(),
  opensearch: () => opensearchHealth(),
  opa: () => opaHealth(),
  postgres: () => postgresHealth(),
  litellm: () => litellmHealth(),
  langfuse: () => langfuseHealth(),
  dagster: () => dagsterHealth(),
  docling: () => doclingHealth(),
  'victoria-metrics': () => victoriaMetricsHealth(),
  'victoria-logs': () => victoriaLogsHealth(),
  'otel-collector': () => otelCollectorHealth(),
};
