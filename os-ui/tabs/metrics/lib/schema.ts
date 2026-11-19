/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metrics schema barrel
 * USER STORY: As a developer I want the metric model and explorer exports from one module, so that the
 *             public API (`./index.ts`) can re-export them in one line.
 * ARCHITECTURE:
 *   - Re-exports everything from `./model` and `./explorer` (types and functions, not only types).
 */
export * from '@tabs/metrics/lib/model';
export * from '@tabs/metrics/lib/explorer';
