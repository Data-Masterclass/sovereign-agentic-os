/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OAuth provider metadata — endpoints and minimal scopes for Google Drive, OneDrive and Microsoft 365
 * USER STORY: As a user connecting an account I want the OS to ask only for read access, and for mail
 *             draft/send only on a connection where an admin explicitly allowed it.
 * ARCHITECTURE:
 *   - Pure and client-safe. The single source the authorize URL, the code exchange and the
 *     refresh read (`token-set.ts`, `client.ts`, `oauth-apps.ts`, the Connections tab).
 *   - google: Drive `drive.readonly`; microsoft: Graph `Files.Read` + `offline_access`; Microsoft 365:
 *     its read set, plus `Mail.ReadWrite` + `Mail.Send` only when the connection's switch is on.
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
 * SharePoint and OneDrive), read-only — plus `Mail.ReadWrite` and `Mail.Send` only for a connection
 * whose admin turned on "Allow drafting and sending mail" (`opts.allowMailSend`).
 * `ChannelMessage.Read.All` needs admin consent in Entra (see docs/components/connections-accounts.md).
 */
// Deliberate, minimal set: `User.Read` covers "connected as" (Graph /me), so no `openid profile email`.
export const MICROSOFT_365_SCOPES: readonly string[] = [
  'offline_access', 'User.Read',
  'Mail.Read', 'Calendars.Read', 'Files.Read.All', 'Sites.Read.All',
  'Chat.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All',
];

/**
 * The two delegated scopes a Microsoft 365 connection adds ONLY when its switch "Allow drafting and
 * sending mail" is on: `Mail.ReadWrite` (a draft is a message in the user's own Drafts) and `Mail.Send`.
 */
export const MICROSOFT_365_MAIL_WRITE_SCOPES: readonly string[] = ['Mail.ReadWrite', 'Mail.Send'];

/** The per-connection switches that widen what a connection asks for. */
export type ScopeOptions = { allowMailSend?: boolean };

export function scopesForTemplate(template: ConnectionTemplateKey, opts: ScopeOptions = {}): string[] {
  if (template === 'microsoft-365') {
    return opts.allowMailSend === true ? [...MICROSOFT_365_SCOPES, ...MICROSOFT_365_MAIL_WRITE_SCOPES] : [...MICROSOFT_365_SCOPES];
  }
  if (template === 'onedrive') return [...OAUTH_PROVIDERS.microsoft.scopes, 'User.Read'];
  const p = providerForTemplate(template);
  return p ? [...OAUTH_PROVIDERS[p].scopes] : [];
}

/**
 * Every READ scope any template asks of this provider: what the admin registers / consents to once.
 * The mail-write scopes are listed apart (`optionalScopesForProvider`): they are needed only when a
 * connection turns its switch on.
 */
export function allScopesForProvider(provider: OAuthProvider): string[] {
  const templates: ConnectionTemplateKey[] = provider === 'microsoft' ? ['onedrive', 'microsoft-365'] : ['gdrive'];
  return [...new Set(templates.flatMap((t) => scopesForTemplate(t)))];
}

/** Scopes asked only by a connection whose admin switched a write on (Microsoft: mail draft and send). */
export function optionalScopesForProvider(provider: OAuthProvider): string[] {
  return provider === 'microsoft' ? [...MICROSOFT_365_MAIL_WRITE_SCOPES] : [];
}

const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/';

/**
 * Does a granted scope string (the token response's space-separated `scope`) hold every scope in
 * `required`? Microsoft may answer with the resource prefix (`https://graph.microsoft.com/Mail.Send`)
 * and in either case, so both sides are normalised. An absent grant holds nothing.
 */
export function grantHasScopes(granted: string | undefined | null, required: readonly string[]): boolean {
  if (!granted) return false;
  const norm = (x: string) => (x.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX) ? x.slice(GRAPH_SCOPE_PREFIX.length) : x).toLowerCase();
  const have = new Set(granted.split(/\s+/).filter(Boolean).map(norm));
  return required.every((r) => have.has(norm(r)));
}

/** The provider config with the scopes of one connection (what the authorize URL asks for). */
export function providerConfigForTemplate(template: ConnectionTemplateKey, opts: ScopeOptions = {}): OAuthProviderConfig | null {
  const p = providerForTemplate(template);
  return p ? { ...OAUTH_PROVIDERS[p], scopes: scopesForTemplate(template, opts) } : null;
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
