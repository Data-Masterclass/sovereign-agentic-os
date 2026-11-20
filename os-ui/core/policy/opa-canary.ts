/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OPA canary document that says "os-ui's runtime policy state is in this OPA".
 * USER STORY: As an operator I want the web app and the run worker to agree on one signal for
 *             "OPA lost its state", so the worker holds runs exactly when the web app restores.
 * ARCHITECTURE:
 *   - A constant only (no imports), so the worker can read it without loading the reconciler.
 *   - Written last by every successful reconcile (`opa-reconcile.ts`); undefined after an OPA
 *     restart because REST-pushed data lives in OPA's memory.
 */
export const OPA_CANARY_PATH = 'os_state/reconciled';
