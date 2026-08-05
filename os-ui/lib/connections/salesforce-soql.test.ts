/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * SOQL BUILDING — injection-safe by construction (operational-system-connections.md,
 * Phase 3). buildSearchSoql folds ONLY validated identifiers into the query and escapes
 * every value into a single-quoted literal; a raw user value can never break out of its
 * quotes or add a clause. Pure — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchSoql,
  soqlStringLiteral,
  safeSObjectName,
  safeSalesforceId,
  SF_SEARCH_MAX_LIMIT,
} from './salesforce.ts';

test('buildSearchSoql: validated identifiers + bounded limit', () => {
  const { soql, limit } = buildSearchSoql({ object: 'Account', fields: ['Name', 'Industry'], limit: 10 });
  assert.equal(soql, 'SELECT Id, Name, Industry FROM Account LIMIT 10');
  assert.equal(limit, 10);
});

test('buildSearchSoql: limit clamps to the sane cap; absent ⇒ cap', () => {
  assert.equal(buildSearchSoql({ object: 'Account', fields: [], limit: 100000 }).limit, SF_SEARCH_MAX_LIMIT);
  assert.equal(buildSearchSoql({ object: 'Account', fields: [] }).limit, SF_SEARCH_MAX_LIMIT);
  assert.equal(buildSearchSoql({ object: 'Account', fields: [], limit: -5 }).limit, SF_SEARCH_MAX_LIMIT);
});

test('buildSearchSoql: where equality is escaped, never interpolated raw', () => {
  const { soql } = buildSearchSoql({
    object: 'Contact',
    fields: ['Email'],
    where: [{ field: 'LastName', value: "O'Brien" }],
  });
  // The apostrophe is backslash-escaped inside the single-quoted literal.
  assert.equal(soql, "SELECT Id, Email FROM Contact WHERE LastName = 'O\\'Brien' LIMIT 200");
});

test('buildSearchSoql: term LIKE is escaped', () => {
  const { soql } = buildSearchSoql({ object: 'Account', fields: [], term: "ac%me' OR" });
  assert.match(soql, /Name LIKE '%ac%me\\' OR%'/);
});

test('INJECTION: a value with a quote + second clause cannot escape its literal', () => {
  const evil = "x' OR Id != null OR Name = '";
  const { soql } = buildSearchSoql({ object: 'Account', fields: [], where: [{ field: 'Name', value: evil }] });
  // Every quote in the value is escaped; the OR/!= ride INSIDE the literal, inert.
  assert.ok(!/= 'x' OR Id/.test(soql), 'the injected clause must not become live SOQL');
  assert.match(soql, /Name = 'x\\' OR Id != null OR Name = \\''/);
});

test('INJECTION: a newline-smuggled clause is stripped, not honored', () => {
  const evil = "a'\n-- DROP";
  const lit = soqlStringLiteral(evil);
  assert.ok(!lit.includes('\n'), 'control chars (newline) are stripped');
  assert.ok(!lit.includes("a'") || lit.includes("a\\'"), 'the quote is escaped');
});

test('INJECTION: an unsafe object name is rejected', () => {
  assert.throws(() => buildSearchSoql({ object: 'Account; DROP', fields: [] }), /unsafe object/);
  assert.throws(() => buildSearchSoql({ object: 'Account', fields: ['Name)) --'] }), /unsafe object/);
});

test('safeSObjectName / safeSalesforceId reject non-identifiers / bad ids', () => {
  assert.equal(safeSObjectName('Custom_Object__c'), 'Custom_Object__c');
  assert.throws(() => safeSObjectName("Acc'ount"), /unsafe/);
  assert.equal(safeSalesforceId('001AB0000012xyzAB'), '001AB0000012xyzAB');
  assert.throws(() => safeSalesforceId("001' OR '1'='1"), /unsafe record id/);
  assert.throws(() => safeSalesforceId('short'), /unsafe record id/);
});
