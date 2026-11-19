/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The words for what marketplace "Register" really does
 * USER STORY: As a platform admin I want "Register" to tell me it only marked this OS as
 *             registered, so I do not believe a marketplace listing was requested.
 * ARCHITECTURE:
 *   - Client-safe (no imports), so the plugins page can show it without pulling the store
 *     (which writes through to OpenSearch) into the browser bundle. `plugins.ts` records it.
 */
export const REGISTRATION_NOTE = 'Marked as registered in this OS; no external marketplace call was made.';
