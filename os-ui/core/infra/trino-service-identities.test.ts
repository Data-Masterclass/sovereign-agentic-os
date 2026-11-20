/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One list of Trino service identities, shared by the OS user directory and OPA
 * USER STORY: As an admin I can never create an OS user whose id is a Trino service identity, so a
 *             run grant can never name a service user and turn an agent run into "act as anyone"
 *             (WP-14 verifier finding B1).
 * ARCHITECTURE:
 *   - The chart's OPA data file `policies/service_identities.json` is this module's render, byte
 *     for byte (REGEN_GOLDEN=1 rewrites it); `trino_impersonation.rego` reads it as
 *     `data.service_identities`, `createUser` reads the module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMPERSONATING_SERVICE_USERS,
  isServiceIdentity,
  renderServiceIdentitiesJson,
} from '@core/infra/trino-service-identities';

const CHART_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'charts', 'sovereign-agentic-os', 'policies', 'service_identities.json');

test('the chart OPA data file IS this module (one list, two readers)', () => {
  const rendered = renderServiceIdentitiesJson();
  if (process.env.REGEN_GOLDEN === '1') writeFileSync(CHART_FILE, rendered);
  assert.equal(readFileSync(CHART_FILE, 'utf8'), rendered, 'policies/service_identities.json differs (REGEN_GOLDEN=1 to accept)');
});

test('every service identity the Rego knows is reserved, by prefix and by name', () => {
  for (const id of [...IMPERSONATING_SERVICE_USERS, 'svc-anything', 'SVC-OS-UI', 'os-domain-delete', 'northpeak-marts', 'dbt-runner', 'query-agent']) {
    assert.equal(isServiceIdentity(id), true, id);
  }
  for (const id of ['alice@x.com', 'sales', 'svcuser', 'my-svc-os-ui', 'admin']) assert.equal(isServiceIdentity(id), false, id);
  assert.deepEqual([...IMPERSONATING_SERVICE_USERS].sort(), ['svc-dagster-runner', 'svc-os-ui', 'svc-os-worker']);
});
