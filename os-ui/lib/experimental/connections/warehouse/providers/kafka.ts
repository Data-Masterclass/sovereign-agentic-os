/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Apache Kafka provider — STREAMING source (federate + offset-cursor sync; NO
 * one-time import-as-product). Trino native `kafka` connector, read-only.
 *
 * ENGINE SPECIFICS (verified against the Trino kafka connector docs):
 *   - `connector.name=kafka`; `kafka.nodes=<host:port,…>`; each CONFIGURED topic is
 *     one table (`kafka.table-names`), in the `default` schema.
 *   - `kafka.hide-internal-columns=false` — the internal columns (`_partition_id`,
 *     `_partition_offset`, `_timestamp`, `_message`, `_key`, …) MUST be queryable:
 *     the scheduled `kafka-offsets` sync slices by partition/offset high-water marks.
 *   - Without a table-description file the message lands as the raw `_message`
 *     varchar (+ `_key`); columns are parsed downstream (Silver), not by the broker.
 *   - SECURITY (honest): `kafka.security-protocol` supports PLAINTEXT and SSL only.
 *     SSL uses the JVM default truststore (public-CA broker certs). SASL and custom
 *     key/truststores require an operator-mounted `kafka.config.resources` file on
 *     the Trino pod — file mounts are NOT wired by one-click registration, so this
 *     provider does not pretend to collect SASL credentials it cannot deliver.
 *     Consequently there is NO secret material at all (keyless, like Glue).
 *
 * CAPABILITIES (honest): federate + sync only. `import` is OFF — a topic is an
 * unbounded stream, so "import as product" is exactly the append-only scheduled
 * sync (which creates the Bronze copy on its first run), not a one-time CTAS.
 */

import {
  type KafkaConfig,
  type WarehouseSource,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';

/** Validate one broker `host[:port]` (default 9092). Same discipline as the JDBC
 *  authority builders: nothing unvalidated is folded into the rendered props. */
function brokerAuthority(raw: string): string {
  const s = (raw ?? '').trim();
  const colon = s.lastIndexOf(':');
  let host = s;
  let port = '';
  if (colon > 0 && /^\d+$/.test(s.slice(colon + 1))) {
    host = s.slice(0, colon);
    port = s.slice(colon + 1);
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host)) {
    throw new WarehouseError(`kafka: invalid broker host '${raw}'`);
  }
  if (port && !/^\d{1,5}$/.test(port)) {
    throw new WarehouseError(`kafka: invalid broker port '${port}'`);
  }
  return `${host}:${port || 9092}`;
}

/** A topic name that stays addressable through the governed three-part FQN
 *  (`<catalog>.default.<topic>`): the same `[a-z_][a-z0-9_]*` rule every other
 *  identifier obeys. Topics with dots/dashes/uppercase are honestly rejected. */
function safeTopic(name: string): string {
  const s = (name ?? '').trim();
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) {
    throw new WarehouseError(
      `kafka: topic '${name}' is not addressable as a governed table — v1 supports topics matching [a-z_][a-z0-9_]* only`,
    );
  }
  return s;
}

function kafkaProps(cfg: KafkaConfig): TrinoCatalogProps {
  const brokers = (cfg.bootstrapServers ?? '').split(',').map((b) => b.trim()).filter(Boolean);
  if (brokers.length === 0) throw new WarehouseError('kafka: missing bootstrap servers');
  const nodes = brokers.map(brokerAuthority).join(',');

  const topics = (cfg.topics ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (topics.length === 0) throw new WarehouseError('kafka: at least one topic is required');
  const tableNames = topics.map(safeTopic).join(',');

  const protocol = (cfg.securityProtocol ?? 'PLAINTEXT').trim().toUpperCase();
  if (protocol !== 'PLAINTEXT' && protocol !== 'SSL') {
    throw new WarehouseError(
      `kafka: security protocol '${cfg.securityProtocol}' is not supported (PLAINTEXT or SSL; SASL needs an operator-mounted kafka.config.resources file)`,
    );
  }

  const props: TrinoCatalogProps = {
    'connector.name': 'kafka',
    'kafka.nodes': nodes,
    'kafka.table-names': tableNames,
    'kafka.default-schema': 'default',
    // The offset-cursor sync NEEDS _partition_id/_partition_offset/_timestamp
    // queryable — never hide the internal columns on a governed Kafka catalog.
    'kafka.hide-internal-columns': 'false',
  };
  if (protocol !== 'PLAINTEXT') props['kafka.security-protocol'] = protocol;
  return props;
}

export const kafkaProvider: WarehouseProvider = {
  platform: 'kafka',
  label: 'Apache Kafka',
  trinoConnector: 'kafka',
  nativeInImage: true,
  // Federate + scheduled sync only. Import-as-product is OFF: a topic is an
  // unbounded stream — the append-only kafka-offsets sync IS the landing path
  // (it creates the Bronze copy on its first run).
  capabilities: { federate: true, import: false, sync: true },
  category: 'streaming',
  catalogProps: (source) => kafkaProps(source as KafkaConfig),
  // `SHOW TABLES FROM <catalog>.default` lists exactly the CONFIGURED topics —
  // there is no broker-side discovery beyond them (honest, not a limitation of
  // the OS: the connector only mounts what kafka.table-names declares).
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  identifierRules: { quote: '"', unquotedCase: 'lower' },
  discoveryMode: 'show',
  notes: [
    'STREAMING source: federate + scheduled sync only — no one-time import. The append-only kafka-offsets sync lands messages in the lakehouse (creating the Bronze table on its first run); de-duplicate downstream if producers retry.',
    'Only the CONFIGURED topics are visible (kafka.table-names). Adding a topic means editing the connection and re-registering the catalog. Topic names must match [a-z_][a-z0-9_]* to be addressable as governed tables (v1).',
    'Without a table-description file the message arrives as the raw `_message` varchar (+ `_key`); parse fields downstream in Silver. Internal columns (_partition_id, _partition_offset, _timestamp) are exposed for the offset cursor.',
    'SECURITY: PLAINTEXT or SSL (JVM default truststore) only. SASL and custom key/truststores require an operator-mounted kafka.config.resources file on the Trino pod — not wired by one-click registration; use the GitOps path (values.trino.externalCatalogs) for those brokers.',
    'Reads scan the topic from the brokers (bounded by kafka.messages-per-split); offset-range predicates on _partition_offset prune what the sync reads.',
  ],
  credentialFields: [
    { key: 'bootstrapServers', label: 'Bootstrap servers', kind: 'text', required: true, help: 'Comma-separated broker list, e.g. kafka-1.internal:9092,kafka-2.internal:9092 (default port 9092).' },
    { key: 'topics', label: 'Topics', kind: 'text', required: true, help: 'Comma-separated topic names to expose as tables, e.g. orders,payments. Lowercase [a-z_][a-z0-9_]* only (v1).' },
    { key: 'securityProtocol', label: 'Security protocol', kind: 'text', required: false, help: 'PLAINTEXT (default) or SSL (JVM default truststore). SASL needs an operator-mounted config file — see the Installation Guide.' },
  ],
  // Keyless (like Glue): PLAINTEXT/SSL-with-default-truststore carries no secret.
  // SASL credentials are deliberately NOT collected — they could not be delivered
  // (Trino's kafka connector takes them only from a mounted config file).
  secretMaterial: { secretKeys: [], envVars: [] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'Kafka',
    configKeys: ['bootstrapServers', 'topics'],
  },
  liveVerificationRequired: [
    'broker reachability from the Trino pod (kafka.nodes, network policy) against a live cluster',
    'SSL handshake with the broker certificates (JVM default truststore) where securityProtocol=SSL',
    'end-to-end offset sync against a live topic (probe + slice + append)',
  ],
};
