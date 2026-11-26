/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Print the agent-schedule CronJob os-ui creates at run time, with its LIVE defaults.
 * USER STORY: As the chart test (scripts/tests/cronjob-secrets-chart.test.sh) I want the exact
 *             manifest os-ui would POST to the API server, so its Secret references are checked
 *             against the Secrets the chart renders — a default that names a Secret no profile
 *             creates is how saved cron schedules never fired (fixed 2026-11-26).
 * ARCHITECTURE: Calls `buildCronJobManifest` with `config`'s defaults (no injected values) and
 *             prints JSON. Run from os-ui with the test alias hook:
 *               node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/print-schedule-cronjob.ts
 */
import { buildCronJobManifest } from '@tabs/agents/lib/schedule-cron';
import { config } from '@core/kernel/config';

const manifest = buildCronJobManifest('sys_chart_test', '0 9 * * 1', {
  namespace: config.platformNamespace,
  targetUrl: config.scheduledRunUrl,
  image: config.scheduleCronImage,
  tokenSecret: config.agentRuntimeTokenSecret,
  tokenSecretKey: config.agentRuntimeTokenSecretKey,
});
console.log(JSON.stringify(manifest));
