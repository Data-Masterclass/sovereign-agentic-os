/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Write an os-data bundle file with os-ui's own bundle writer (core/policy/bundle.ts buildBundle):
 * the chart seed (OS_OPA_SEED) plus one runtime-only grant, `user:pvc-proof: [query]`, which no
 * seed file carries, so its presence in OPA proves the bundle (not a file) was activated.
 * usage (from os-ui/): OS_OPA_SEED=… node --import ./scripts/test-setup.mjs ../tests/opa/make-bundle.ts <out.tar.gz>
 */
import { writeFileSync } from 'node:fs';

const { buildBundle } = await import('@core/policy/bundle');
const { OS_DATA_ROOTS } = await import('@core/policy/opa-publish');
const seed = JSON.parse(process.env.OS_OPA_SEED ?? '{}') as Record<string, unknown>;
const data = { ...seed, grants: { 'user:pvc-proof': ['query'] } };
const probe = buildBundle('os-data', data, OS_DATA_ROOTS);
const b = buildBundle('os-data', data, OS_DATA_ROOTS, `1-${probe.hash}`);
writeFileSync(process.argv[2], b.bytes);
console.log(b.revision);
