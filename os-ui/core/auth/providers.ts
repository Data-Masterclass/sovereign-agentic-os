/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OAuth provider metadata — endpoints and minimal read scopes for Google Drive and OneDrive
 * USER STORY: As a user connecting a personal drive I want the OS to ask only for read access so
 *             that the connector can never change my files.
 * ARCHITECTURE:
 *   - Pure and client-safe. The single source the authorize URL, the code exchange and the
 *     refresh read (`token-set.ts`, `client.ts`, `oauth-apps.ts`, the Connections tab).
 *   - google: Drive `drive.readonly`; microsoft: Graph `Files.Read` + `offline_access`.
 *   - Maps connection templates (`gdrive`, `onedrive`) to providers and providers to Files-tab
 *     connector ids.
 */
import type { ConnectionTemplateKey } from '@tabs/connections/lib/schema';
import type { Provider as FilesProvider } from '@tabs/files/lib/connectors';

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
  /**
   * A cheap, READ-ONLY "who am I / is this drive reachable" endpoint used by the
   * honest `testConnection` probe (Google Drive `about.get`; Graph `/me/drive`).
   * Called with the stored access token — success ⇒ the token really works.
   */
  probeUrl: string;
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
    // Drive `about.get` — the smallest authenticated read; 200 ⇒ token works.
    probeUrl: 'https://www.googleapis.com/drive/v3/about?fields=user',
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
    // Graph `/me/drive` — the signed-in user's OneDrive; 200 ⇒ token works.
    probeUrl: 'https://graph.microsoft.com/v1.0/me/drive?$select=id',
  },
};

/** Map a connection template → the OAuth provider that authenticates it. */
export function providerForTemplate(template: ConnectionTemplateKey): OAuthProvider | null {
  if (template === 'gdrive') return 'google';
  if (template === 'onedrive' || template === 'microsoft-365') return 'microsoft';
  return null;
}

/**
 * The delegated scopes ONE connection template asks for. The drive templates keep the provider's
 * minimal read scopes (plus `User.Read` on Microsoft, so the OS can show which account is
 * connected); Microsoft 365 asks for the read scopes its chat tools need (mail, calendar, Teams,
 * SharePoint and OneDrive). Every scope is read-only: the chat tools never write to the account.
 * `ChannelMessage.Read.All` needs admin consent in Entra (see docs/components/connections-accounts.md).
 */
export const MICROSOFT_365_SCOPES: readonly string[] = [
  'openid', 'profile', 'email', 'offline_access', 'User.Read',
  'Mail.Read', 'Calendars.Read', 'Files.Read.All', 'Sites.Read.All',
  'Chat.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All',
];

export function scopesForTemplate(template: ConnectionTemplateKey): string[] {
  if (template === 'microsoft-365') return [...MICROSOFT_365_SCOPES];
  if (template === 'onedrive') return [...OAUTH_PROVIDERS.microsoft.scopes, 'User.Read'];
  const p = providerForTemplate(template);
  return p ? [...OAUTH_PROVIDERS[p].scopes] : [];
}

/** Every scope any template asks of this provider: what the admin registers / consents to once. */
export function allScopesForProvider(provider: OAuthProvider): string[] {
  const templates: ConnectionTemplateKey[] = provider === 'microsoft' ? ['onedrive', 'microsoft-365'] : ['gdrive'];
  return [...new Set(templates.flatMap((t) => scopesForTemplate(t)))];
}

/** The provider config with the scopes of one template (what the authorize URL asks for). */
export function providerConfigForTemplate(template: ConnectionTemplateKey): OAuthProviderConfig | null {
  const p = providerForTemplate(template);
  return p ? { ...OAUTH_PROVIDERS[p], scopes: scopesForTemplate(template) } : null;
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
