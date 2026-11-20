/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The version a VictoriaMetrics / VictoriaLogs binary states is shown as it states it
 *             (WP-05 review #2).
 * USER STORY: As an operator I want an enterprise or custom build to show up as exactly that on the
 *             Platform page — not as "invalid", and not as a clean release number it is not.
 * ARCHITECTURE: `vmVersion` over real `app_version` strings from the pinned images, plus the forms
 *   the review used (enterprise, heads-master, arbitrary).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promLabel, vmVersion } from '@core/adapters/health/http';

const line = (v: string) => `vm_log_messages_total{app_version="${v}", level="info"} 1\n`;

test('a release build gives its tag (the strings the pinned images export)', () => {
  assert.equal(vmVersion(line('victoria-metrics-20261106-175016-tags-v1.156.0-0-g0c1bf87a0c')), 'v1.156.0');
  assert.equal(vmVersion(line('victoria-logs-20261113-102924-tags-v1.54.0-0-g6433dae586')), 'v1.54.0');
});

test('an enterprise build says so; any other build is shown verbatim, never dropped (negative twins)', () => {
  assert.equal(vmVersion(line('victoria-metrics-20261106-175016-tags-v1.156.0-enterprise-0-g4810ab')), 'v1.156.0-enterprise');
  assert.equal(vmVersion(line('victoria-metrics-20261120-090000-heads-master-0-gdeadbeef')), 'victoria-metrics-20261120-090000-heads-master-0-gdeadbeef');
  assert.equal(vmVersion(line('my-custom-build')), 'my-custom-build');
  assert.equal(vmVersion('vm_rows 1\n'), null);
});

test('promLabel reads one label of one metric', () => {
  assert.equal(promLabel('otelcol_process_uptime_seconds_total{service_name="otelcol-k8s",service_version="0.165.0"} 3\n', 'otelcol_process_uptime_seconds_total', 'service_version'), '0.165.0');
  assert.equal(promLabel('x 1\n', 'otelcol_process_uptime_seconds_total', 'service_version'), null);
});
