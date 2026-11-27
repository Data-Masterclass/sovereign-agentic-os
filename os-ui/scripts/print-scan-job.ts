/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Print the scan Job and payload Secret os-ui creates for one security scan.
 * USER STORY: As the scanner admission test (scripts/tests/scanner-admission.kind.sh) I want the
 *             EXACT objects os-ui would POST, so the real API server proves the scanner namespace's
 *             policy admits them — a hand-written copy of the shape could pass while os-ui's own
 *             manifest is refused, and every deploy would then sit at "scan unavailable".
 * ARCHITECTURE: Calls `buildScanJobManifest` / `buildPayloadSecretManifest` with os-ui's own args and
 *             default resources. SCAN_IMAGE / SCAN_NAMESPACE / SCAN_JOB_UID come from the caller (the
 *             chart's rendered image and namespace). Prints `{"job": …, "secret": …}`. Run from os-ui:
 *               node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/print-scan-job.ts
 */
import {
  buildScanJobManifest,
  buildPayloadSecretManifest,
  scanJobName,
  trivyArgs,
  writerScript,
  DEFAULT_SCAN_RESOURCES,
} from '@tabs/software/lib/scan-trivy';
import { config } from '@core/kernel/config';

const namespace = process.env.SCAN_NAMESPACE || `${config.platformNamespace}-scans`;
const image = process.env.SCAN_IMAGE || config.softwareScannerImage;
const name = scanJobName(process.env.SCAN_SLUG || 'shop', process.env.SCAN_RUN_ID || 'kindtest1');
const args = trivyArgs({ dbMode: config.softwareScannerDbMode as 'mirror' | 'offline', dbRepository: config.softwareScannerDbRepository });
const writer = writerScript([{ path: 'package.json', content: '{"name":"shop"}\n' }]);
if (!writer.ok) throw new Error(writer.reason);
const job = buildScanJobManifest({ name, namespace, image, args, timeoutMs: config.softwareScannerTimeoutMs, resources: DEFAULT_SCAN_RESOURCES });
const secret = buildPayloadSecretManifest({ name, namespace, script: writer.script, jobUid: process.env.SCAN_JOB_UID || '00000000-0000-0000-0000-000000000000' });
console.log(JSON.stringify({ job, secret }));
