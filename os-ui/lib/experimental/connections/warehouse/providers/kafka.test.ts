/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kafkaProvider } from './kafka.ts';
import { WarehouseError, type WarehouseSource } from '../types.ts';

function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'kafka_events',
    platform: 'kafka',
    bootstrapServers: 'kafka-1.internal:9092,kafka-2.internal',
    topics: 'orders,payments',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------------- catalog props ----

test('kafka props: connector, nodes (default port), tables, internal columns EXPOSED', () => {
  const props = kafkaProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'kafka');
  assert.equal(props['kafka.nodes'], 'kafka-1.internal:9092,kafka-2.internal:9092');
  assert.equal(props['kafka.table-names'], 'orders,payments');
  assert.equal(props['kafka.default-schema'], 'default');
  // The offset cursor NEEDS _partition_id/_partition_offset/_timestamp queryable.
  assert.equal(props['kafka.hide-internal-columns'], 'false');
  // PLAINTEXT default → no security-protocol line at all.
  assert.equal(props['kafka.security-protocol'], undefined);
});

test('kafka props: SSL is emitted; SASL is honestly rejected (config-file only)', () => {
  assert.equal(
    kafkaProvider.catalogProps(src({ securityProtocol: 'ssl' } as Partial<WarehouseSource>))['kafka.security-protocol'],
    'SSL',
  );
  assert.throws(
    () => kafkaProvider.catalogProps(src({ securityProtocol: 'SASL_SSL' } as Partial<WarehouseSource>)),
    /kafka\.config\.resources/,
  );
});

test('kafka props validate brokers and topics (no injection, honest rejects)', () => {
  assert.throws(() => kafkaProvider.catalogProps(src({ bootstrapServers: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => kafkaProvider.catalogProps(src({ bootstrapServers: 'bad host:9092' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => kafkaProvider.catalogProps(src({ topics: '' } as Partial<WarehouseSource>)), WarehouseError);
  // Topics outside [a-z_][a-z0-9_]* are not addressable through the governed FQN — reject.
  assert.throws(() => kafkaProvider.catalogProps(src({ topics: 'orders.created' } as Partial<WarehouseSource>)), /not addressable/);
  assert.throws(() => kafkaProvider.catalogProps(src({ topics: 'Orders' } as Partial<WarehouseSource>)), WarehouseError);
});

// ------------------------------------------------- capabilities + honesty -------

test('kafka is federate+sync only (no import), streaming category, keyless', () => {
  assert.deepEqual(kafkaProvider.capabilities, { federate: true, import: false, sync: true });
  assert.equal(kafkaProvider.category, 'streaming');
  // No secret material at all — SASL creds are deliberately NOT collected (they
  // could only be delivered via an operator-mounted config file, never ${ENV:...}).
  assert.deepEqual(kafkaProvider.secretMaterial, { secretKeys: [], envVars: [] });
  for (const f of kafkaProvider.credentialFields) {
    assert.notEqual(f.kind, 'password', `${f.key} must not collect a secret it cannot deliver`);
  }
});

test('kafka discovery lists only the configured topics; probe is SHOW SCHEMAS', () => {
  assert.equal(kafkaProvider.discoverTables!(src(), 'default'), 'SHOW TABLES FROM kafka_events.default');
  assert.throws(() => kafkaProvider.discoverTables!(src(), 'bad schema'), WarehouseError);
  assert.equal(kafkaProvider.testProbe.kind, 'sql');
  if (kafkaProvider.testProbe.kind === 'sql') {
    assert.equal(kafkaProvider.testProbe.query(src()), 'SHOW SCHEMAS FROM kafka_events');
  }
});

test('kafka never emits a secret value into props', () => {
  const props = kafkaProvider.catalogProps(src({ securityProtocol: 'SSL' } as Partial<WarehouseSource>));
  for (const [k, v] of Object.entries(props)) {
    assert.ok(!/password|secret|sasl\.jaas/i.test(`${k}=${v}`), `${k} carries no credential material`);
  }
});
