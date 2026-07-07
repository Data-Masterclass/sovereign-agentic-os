/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Connected-drive status — PURE + client-safe (no secrets, no server imports), so
 * the Connections tab and its unit tests share ONE source of truth for:
 *   • what a personal Drive/OneDrive connection's status is (Not connected /
 *     Connected / needs reconnect), derived only from the safe fields the API
 *     already returns (never a token), and
 *   • the full-page authorize URL the "Connect" button navigates to (which 302s to
 *     the provider consent screen).
 */

import type { OAuthProvider } from './providers.ts';

export type DriveConnectionStatus = 'not-connected' | 'connected' | 'needs-reconnect';

/**
 * Derive the personal-drive status from a connection's SAFE health field. A freshly
 * created OAuth drive holds only the offline placeholder → `untested` → Not
 * connected. Completing consent stores the real token set → `healthy` → Connected.
 * A stale token whose silent refresh failed → `needs-reconnect`.
 */
export function driveConnectionStatus(c: { health: 'healthy' | 'needs-reconnect' | 'untested' }): DriveConnectionStatus {
  if (c.health === 'needs-reconnect') return 'needs-reconnect';
  if (c.health === 'healthy') return 'connected';
  return 'not-connected';
}

/**
 * The authorize route for a connection's provider. FULL-PAGE navigation target —
 * the route 302-redirects to the provider consent screen, so the button uses a
 * real navigation (not fetch).
 */
export function driveAuthorizePath(provider: OAuthProvider, connectionId: string): string {
  return `/api/connections/oauth/${provider}/authorize?connectionId=${encodeURIComponent(connectionId)}`;
}
