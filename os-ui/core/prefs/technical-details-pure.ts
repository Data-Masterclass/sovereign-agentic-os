/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    "Show technical details" — the per-user opt-in, the PURE half
 * USER STORY: As someone who uses the OS to get work done I do not want panels about its
 *             internals (the "Under the hood" artefact view) on my pages; as an engineer I want
 *             one switch that brings them back for me, on this device.
 * ARCHITECTURE:
 *   - Import-free (no React, no window) so the default and the parsing are unit-testable and
 *     the hook in `@core/ui/useTechnicalDetails` is plumbing only.
 *   - OFF is the default and the fail-safe: anything but the exact stored "on" value —
 *     nothing stored, storage blocked, a value from an older build — reads as off.
 *   - Browser storage only, by decision: this is a per-device viewing convenience, not a
 *     permission. The API route and the MCP tool behind the panel are untouched and stay
 *     role-gated on the server.
 */

/** The localStorage key (same `soa-` prefix as the theme choice). */
export const TECHNICAL_DETAILS_KEY = 'soa-technical-details';

/** The window event that keeps every mounted reader in step within one tab. */
export const TECHNICAL_DETAILS_EVENT = 'os:technical-details';

/** Off unless the user has explicitly switched it on. */
export const TECHNICAL_DETAILS_DEFAULT = false;

/** Read a stored value. Only the exact "on" string enables; everything else is off. Never throws. */
export function parseTechnicalDetails(stored: unknown): boolean {
  return stored === 'on' ? true : TECHNICAL_DETAILS_DEFAULT;
}

/** The value written to storage for a choice. */
export function serializeTechnicalDetails(on: boolean): 'on' | 'off' {
  return on ? 'on' : 'off';
}
