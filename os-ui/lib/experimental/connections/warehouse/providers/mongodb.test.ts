/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mongoProvider, validateMongoHost } from './mongodb.ts';
import { WarehouseError, type WarehouseSource, type MongoConfig } from '../types.ts';

function src(override: Partial<WarehouseSource> = {}): WarehouseSource {
  return {
    catalog: 'mongo_events',
    platform: 'mongodb',
    host: 'mongo.internal',
    ...(override as object),
  } as WarehouseSource;
}

// ------------------------------------------------------- connector + mapping ----

test('mongo props: connector name, vaulted connection-url, schema collection, case-insensitive', () => {
  const props = mongoProvider.catalogProps(src());
  assert.equal(props['connector.name'], 'mongodb');
  assert.equal(props['mongodb.connection-url'], '${ENV:MONGODB_CONNECTION_URL}');
  assert.equal(props['mongodb.schema-collection'], '_schema');
  assert.equal(props['mongodb.case-insensitive-name-matching'], 'true');
});

// ---------------------------- the WHOLE url (incl credentials) is the secret ----

test('mongo NEVER inlines a connection URL or credentials into props', () => {
  // Even if a raw URL with credentials were smuggled through the config, no prop may
  // contain it — the URL is referenced ONLY via ${ENV:MONGODB_CONNECTION_URL}.
  const props = mongoProvider.catalogProps(
    src({ connectionUrlSecretRef: 'mongodb://admin:s3cr3t@mongo.internal/db' } as Partial<WarehouseSource>),
  );
  for (const [k, v] of Object.entries(props)) {
    assert.ok(!/s3cr3t/.test(v), `${k} must not contain the raw credentials`);
    assert.ok(!/admin:/.test(v), `${k} must not contain an inlined user:pass`);
    assert.ok(!/^mongodb(\+srv)?:\/\//.test(v), `${k} must not be an inlined connection URL`);
  }
});

test('mongo secretMaterial pairs the connection URL with its env var', () => {
  assert.deepEqual(mongoProvider.secretMaterial, {
    secretKeys: ['mongodb-connection-url'],
    envVars: ['MONGODB_CONNECTION_URL'],
  });
});

// --------------------------------------------------- host validation (metadata) ----

test('validateMongoHost applies the default port and strips scheme/credentials', () => {
  assert.equal(validateMongoHost({ platform: 'mongodb', host: 'mongo.internal' }), 'mongo.internal:27017');
  assert.equal(
    validateMongoHost({ platform: 'mongodb', host: 'mongodb://user:pass@mongo.internal:5000/db' }),
    'mongo.internal:5000',
  );
});

test('validateMongoHost: SRV host carries no port, and rejects an SRV host with a port', () => {
  assert.equal(validateMongoHost({ platform: 'mongodb', host: 'cluster0.abc.mongodb.net', srv: true }), 'cluster0.abc.mongodb.net');
  assert.throws(
    () => validateMongoHost({ platform: 'mongodb', host: 'cluster0.abc.mongodb.net', port: '27017', srv: true } as MongoConfig),
    (e: unknown) => e instanceof WarehouseError && /srv/i.test((e as Error).message),
  );
});

test('mongo rejects a missing/malformed host', () => {
  assert.throws(() => mongoProvider.catalogProps(src({ host: '' } as Partial<WarehouseSource>)), WarehouseError);
  assert.throws(() => mongoProvider.catalogProps(src({ host: 'bad host!' } as Partial<WarehouseSource>)), WarehouseError);
});

// -------------------------------------------------- engine-specific: identifiers ----

test('mongo is schemaless: case-preserving, show discovery', () => {
  assert.deepEqual(mongoProvider.identifierRules, { quote: '"', unquotedCase: 'preserve' });
  assert.equal(mongoProvider.discoveryMode, 'show');
});

// -------------------------------------------------- engine-specific: type handling ----

test('mongo document/array → json, objectid → varchar', () => {
  const rules = mongoProvider.importTypeRules!;
  const hit = (t: string) => rules.find((r) => r.match.test(t));
  assert.equal(hit('object')!.castTo, 'json');
  assert.equal(hit('document')!.castTo, 'json');
  assert.equal(hit('array(varchar)')!.castTo, 'json');
  assert.equal(hit('objectid')!.castTo, 'varchar');
  assert.equal(hit('bigint'), undefined); // scalar passes through
});

test('mongo notes are honest about schema inference + _schema write requirement', () => {
  const joined = (mongoProvider.notes ?? []).join(' ');
  assert.ok(/SCHEMALESS/i.test(joined), 'flags schemaless inference');
  assert.ok(/_schema/.test(joined), 'flags the _schema collection');
  assert.ok(/WRITE access/i.test(joined), 'flags the _schema write requirement');
});

test('mongo liveVerificationRequired lists schema-inference honesty', () => {
  const joined = mongoProvider.liveVerificationRequired.join(' ');
  assert.ok(/schema-inference/i.test(joined));
});

test('mongo test probe is a cheap reachability SHOW SCHEMAS', () => {
  assert.equal(mongoProvider.testProbe.kind, 'sql');
  if (mongoProvider.testProbe.kind === 'sql') {
    assert.equal(mongoProvider.testProbe.query(src()), 'SHOW SCHEMAS FROM mongo_events');
  }
});
