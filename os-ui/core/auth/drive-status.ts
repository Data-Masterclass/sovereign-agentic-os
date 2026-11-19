/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connected-drive status — derive the Drive/OneDrive status and the authorize link
 * USER STORY: As a user on the Connections tab I want to see whether my drive is connected or
 *             needs a reconnect, and a Connect button that starts consent, so that I know what to do.
 * ARCHITECTURE:
 *   - Pure and client-safe: no secrets, no server imports. Shared by
 *     `tabs/connections/ui/ConnectionBuilder.tsx` and its unit test.
 *   - Status comes only from the connection's safe `health` field, never from a token.
 *   - `driveAuthorizePath` is a full-page navigation target; the route 302s to the provider.
 */
import type { OAuthProvider } from '@core/auth/providers';

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
