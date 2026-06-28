/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Static catalog of supported external connectors for the Connections surface
 * (os-application.md §4). Registering a connection stores credentials in the
 * secrets store (never the browser) and shares *use* — never the secret —
 * under OPA policy. The live in-cluster backends are shown separately, sourced
 * from /api/status. This catalog is the "what you can connect" half.
 */

export type ConnectorCategory = 'Database' | 'Warehouse' | 'Object storage' | 'SaaS / API' | 'Streaming';

export type Connector = {
  name: string;
  category: ConnectorCategory;
  /** Whether a driver/integration ships in this deployment. */
  available: boolean;
  auth: string; // credential type held in the secrets store
};

export const CONNECTORS: Connector[] = [
  { name: 'PostgreSQL', category: 'Database', available: true, auth: 'user / password' },
  { name: 'MySQL / MariaDB', category: 'Database', available: true, auth: 'user / password' },
  { name: 'Microsoft SQL Server', category: 'Database', available: false, auth: 'user / password' },
  { name: 'Snowflake', category: 'Warehouse', available: false, auth: 'key pair' },
  { name: 'Google BigQuery', category: 'Warehouse', available: false, auth: 'service account' },
  { name: 'Databricks SQL', category: 'Warehouse', available: false, auth: 'PAT' },
  { name: 'S3 / STACKIT Object Storage', category: 'Object storage', available: true, auth: 'access key' },
  { name: 'MinIO', category: 'Object storage', available: true, auth: 'access key' },
  { name: 'Apache Iceberg (Polaris)', category: 'Warehouse', available: true, auth: 'catalog token' },
  { name: 'REST / GraphQL API', category: 'SaaS / API', available: true, auth: 'bearer / OAuth2' },
  { name: 'Salesforce', category: 'SaaS / API', available: false, auth: 'OAuth2' },
  { name: 'HubSpot', category: 'SaaS / API', available: false, auth: 'private app token' },
  { name: 'Apache Kafka', category: 'Streaming', available: false, auth: 'SASL / mTLS' },
];

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = [
  'Database',
  'Warehouse',
  'Object storage',
  'SaaS / API',
  'Streaming',
];
