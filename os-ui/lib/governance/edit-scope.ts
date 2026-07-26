/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// edit-scope now lives in lib/core (it is access-control shared by every tab,
// and hosting it here created tab↔governance import cycles). Re-export shim so
// existing `governance/edit-scope` importers keep working unchanged.
export * from '../core/edit-scope';
