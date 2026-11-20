/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The durable audit store never rejects an entry over the shape of its detail (WP-31)
 * USER STORY: As an auditor I want every governance entry kept, whatever its structured detail
 *             looks like: a field typed one way by an earlier entry must not make OpenSearch refuse
 *             a later one.
 * ARCHITECTURE: the REAL OpenSearch image we ship (this harness), the os-audit index body os-ui
 *             creates (`os-ui/tabs/admin/lib/os-audit-index.json`: `data` stored, not indexed), and a
 *             negative twin on a dynamically mapped index that must reject the same second entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { os } from './harness.mjs';

const BODY = JSON.parse(readFileSync(new URL('../../os-ui/tabs/admin/lib/os-audit-index.json', import.meta.url), 'utf8'));
const first = { id: 'aud_1', action: 'governance.approve', data: { rung: 'domain', id: 'ds-A' } };
const clash = { id: 'aud_2', action: 'governance.approve', data: { rung: { from: 'my', to: 'domain' }, id: 42 } };

test('os-audit: with `data` not indexed, a later entry whose detail has other types is stored', () => {
  os('DELETE', '/it-os-audit');
  assert.equal(os('PUT', '/it-os-audit', BODY).status, 200);
  assert.equal(os('PUT', '/it-os-audit/_doc/aud_1?refresh=true', first).status, 201);
  assert.equal(os('PUT', '/it-os-audit/_doc/aud_2?refresh=true', clash).status, 201, 'the clashing entry must be kept');
  const back = os('GET', '/it-os-audit/_doc/aud_2');
  assert.deepEqual(back.body._source.data, clash.data, 'the detail is stored verbatim');
  os('DELETE', '/it-os-audit');
});

test('os-audit — NEGATIVE TWIN: on a dynamically mapped index the same entry is rejected', () => {
  os('DELETE', '/it-os-audit-dyn');
  assert.equal(os('PUT', '/it-os-audit-dyn', {}).status, 200);
  assert.equal(os('PUT', '/it-os-audit-dyn/_doc/aud_1?refresh=true', first).status, 201);
  assert.equal(os('PUT', '/it-os-audit-dyn/_doc/aud_2?refresh=true', clash).status, 400, 'dynamic mapping refuses the type clash');
  os('DELETE', '/it-os-audit-dyn');
});
