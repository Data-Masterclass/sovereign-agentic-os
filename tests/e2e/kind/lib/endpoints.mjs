/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Where each component's own API lives in the kind install
 * USER STORY: As a harness author I want one table of Service names and ports, taken from the
 *             chart's render, so a renamed Service breaks one line, not every journey.
 * ARCHITECTURE:
 *   - Names are the chart's Services for release `agentic-os` (helm template, values.local.yaml +
 *     values.e2e.yaml). Components the programme has not added yet (VictoriaLogs WP-05, Keycloak
 *     WP-38, trivy-server WP-42, metric-compile WP-20) use the names their design gives; each can
 *     be overridden with E2E_SVC_<KEY>=name:port. A missing Service is a red hop, by design.
 */
import { portForward } from './kube.mjs';

const DEFAULTS = {
  dagster: 'agentic-os-dagster-webserver:80',
  trino: 'trino:8080',
  opensearch: 'opensearch:9200',
  langfuse: 'agentic-os-langfuse-web:3000',
  litellm: 'agentic-os-litellm:4000',
  opa: 'opa:8181',
  docling: 'docling:5001',
  stub: 'mock-model:8080',
  seaweedfsS3: 'seaweedfs:8333',
  seaweedfsFiler: 'seaweedfs:8888',
  osUi: 'os-ui:3000',
  gitDaemon: 'os-repos:9418',
  victorialogs: 'victorialogs:9428',
  keycloak: 'keycloak:8080',
  metricCompile: 'metric-compile:8080',
  trivyServer: 'trivy-server:4954',
};

export function serviceOf(key) {
  const override = process.env[`E2E_SVC_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
  const [name, port] = (override ?? DEFAULTS[key]).split(':');
  return { name, port: Number(port) };
}

/** Local base URL for a component (starts a port-forward on first use). */
export async function baseUrl(key) {
  const { name, port } = serviceOf(key);
  return (await portForward(name, port)).url;
}

/** Local-dev credentials the chart documents for the laptop profile (values.yaml / values.local.yaml). */
export const LOCAL = {
  litellmMasterKey: process.env.E2E_LITELLM_MASTER_KEY ?? 'sk-litellm-local-dev-master',
  langfusePublicKey: process.env.E2E_LANGFUSE_PUBLIC_KEY ?? 'pk-lf-localdev0000public',
  langfuseSecretKey: process.env.E2E_LANGFUSE_SECRET_KEY ?? 'sk-lf-localdev0000secret',
  trinoUser: process.env.E2E_TRINO_USER ?? 'e2e-harness',
};
