/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Compatibility door to the delegated-identity primitives, now in the kernel
 * USER STORY: As a Data-tab module or test I keep importing `@tabs/data/lib/identity` while the
 *             implementation lives in `@core/kernel/identity`, which other tabs import directly.
 * ARCHITECTURE:
 *   - Re-export only. New code, and every tab other than Data, imports `@core/kernel/identity`.
 */
export * from '@core/kernel/identity';
