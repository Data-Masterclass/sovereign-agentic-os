/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * OAuth provider metadata for the connected-drive flow — PURE + client-safe (no
 * secrets, no server imports). One record per identity provider we federate to
 * for a personal Drive/OneDrive connection:
 *
 *   • google    — Google Cloud OAuth client → Google Drive (drive.readonly)
 *   • microsoft — Azure AD app registration → OneDrive via Microsoft Graph
 *                 (Files.Read + offline_access for a refresh token)
 *
 * The endpoints + MINIMAL scopes here are the single source of truth the
 * authorize URL, the code→token exchange, and the silent refresh all read. The
 * scopes are deliberately least-privilege READ scopes — the connector never asks
 * for write access.
 */

import type { ConnectionTemplateKey } from '@/lib/connections/schema';
import type { Provider as FilesProvider } from '@/lib/files/connectors';

export type OAuthProvider = 'google' | 'microsoft';

export type OAuthProviderConfig = {
  provider: OAuthProvider;
  /** Human label for the consent button / admin config. */
  label: string;
  /** The provider's authorization endpoint (where the user consents). */
  authUrl: string;
  /** The provider's token endpoint (code→token + refresh). */
  tokenUrl: string;
  /** MINIMAL read scopes requested — least privilege. */
  scopes: string[];
  /** Extra authorize-URL params required to obtain a refresh token. */
  extraAuthParams: Record<string, string>;
};

export const OAUTH_PROVIDERS: Record<OAuthProvider, OAuthProviderConfig> = {
  google: {
    provider: 'google',
    label: 'Google Drive',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // Read-only access to the user's Drive files. Nothing else.
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    // access_type=offline + prompt=consent are REQUIRED for Google to return a
    // refresh token (so the connection can silently refresh a stale access token).
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  microsoft: {
    provider: 'microsoft',
    label: 'OneDrive',
    // The multi-tenant "common" endpoint — works for any Microsoft 365 / personal
    // account the admin's Azure app is configured to allow.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // Files.Read = read the signed-in user's OneDrive; offline_access = refresh token.
    scopes: ['Files.Read', 'offline_access'],
    extraAuthParams: { response_mode: 'query' },
  },
};

/** Map a connection template → the OAuth provider that authenticates it. */
export function providerForTemplate(template: ConnectionTemplateKey): OAuthProvider | null {
  if (template === 'gdrive') return 'google';
  if (template === 'onedrive') return 'microsoft';
  return null;
}

/** Map an OAuth provider → the Files-tab connector provider it syncs. */
export function filesProviderFor(provider: OAuthProvider): FilesProvider {
  return provider === 'google' ? 'google-drive' : 'onedrive';
}

/** Narrow an arbitrary string to a known OAuth provider (route param guard). */
export function asOAuthProvider(value: string): OAuthProvider | null {
  return value === 'google' || value === 'microsoft' ? value : null;
}

export function providerConfig(provider: OAuthProvider): OAuthProviderConfig {
  return OAUTH_PROVIDERS[provider];
}
