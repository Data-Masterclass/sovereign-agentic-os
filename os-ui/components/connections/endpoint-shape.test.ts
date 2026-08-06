/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeEndpoint, fixedEndpointHint } from './shared.ts';

/**
 * The client-side endpoint-shape guards behind the Kajabi paste-the-key incident fix.
 * `looksLikeEndpoint` blocks obvious non-URLs (a pasted credential) before they reach the
 * egress path; `fixedEndpointHint` decides which template hints are concrete enough to prefill.
 * Pure string math — no React, no fetch.
 */

test('looksLikeEndpoint accepts real URLs and bare hosts', () => {
  assert.equal(looksLikeEndpoint('https://api.kajabi.com'), true);
  assert.equal(looksLikeEndpoint('api.example.com'), true);          // bare host normalises to https://
  assert.equal(looksLikeEndpoint('http://localhost:3000'), true);    // localhost is a valid dev host
  assert.equal(looksLikeEndpoint('https://mcp.notion.com/mcp'), true);
});

test('looksLikeEndpoint rejects a pasted credential', () => {
  assert.equal(looksLikeEndpoint('sk_live_abc123DEF456ghi'), false); // opaque token, no dot
  assert.equal(looksLikeEndpoint('my-secret-api-key'), false);
  assert.equal(looksLikeEndpoint('9f8e7d6c5b4a'), false);
});

test('looksLikeEndpoint treats empty as valid (the required-field guard owns blanks)', () => {
  assert.equal(looksLikeEndpoint(''), true);
  assert.equal(looksLikeEndpoint('   '), true);
});

test('fixedEndpointHint returns concrete fixed endpoints (prefill)', () => {
  assert.equal(fixedEndpointHint('https://api.kajabi.com'), 'https://api.kajabi.com');
  assert.equal(fixedEndpointHint('https://api.github.com'), 'https://api.github.com');
  assert.equal(fixedEndpointHint('https://slack.com/api'), 'https://slack.com/api');
});

test('fixedEndpointHint returns null for placeholder / generic hints (stay empty)', () => {
  assert.equal(fixedEndpointHint('https://api.example.com'), null);
  assert.equal(fixedEndpointHint('https://mcp.example.com/sse'), null);
  assert.equal(fixedEndpointHint('https://yourorg.my.salesforce.com'), null);
  assert.equal(fixedEndpointHint('https://your-site.atlassian.net'), null);
  assert.equal(fixedEndpointHint('https://<account>.purview.azure.com'), null);
  assert.equal(fixedEndpointHint('https://host/api/data/v9.2'), null);
  assert.equal(fixedEndpointHint('postgres://db.example.com:5432/app'), null); // not http(s)
  assert.equal(fixedEndpointHint('trino-catalog (registered via GitOps values, not a URL)'), null);
  assert.equal(fixedEndpointHint(undefined), null);
  assert.equal(fixedEndpointHint(''), null);
});
