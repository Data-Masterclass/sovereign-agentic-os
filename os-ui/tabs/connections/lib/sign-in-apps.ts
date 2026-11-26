/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The Google and Microsoft sign-in apps: one name, and the "can't connect yet" wording
 * USER STORY: As an admin who adds Microsoft 365, OneDrive or Google Drive I want to be told when the
 *             provider's sign-in app is the missing step, with a direct link to set it up; as anyone else I
 *             want to know whom to ask.
 * ARCHITECTURE:
 *   - Data and wording only; no React, no I/O, so it is unit-testable (a test cannot import a .tsx).
 *     Rendered by tabs/connections/ui/AccountConnections.tsx; the registry card in registries.ts and the
 *     page header at app/(govern)/platform/oauth-apps use SIGN_IN_APPS_NAME.
 *   - The page keeps its /platform/oauth-apps URL. It sits under app/(govern)/platform/layout.tsx, which
 *     admits admins only, so only an admin is offered the link; everyone else is told to ask their admin.
 *   - The browser learns only whether each provider's app is configured (`signInAppsStatus`, booleans).
 *     The client id and secret never leave the server.
 */
import type { Role } from '@core/kernel/session';
import type { OAuthProvider } from '@core/auth/providers';

/** The one name for the page, wherever it is mentioned. */
export const SIGN_IN_APPS_NAME = 'Sign-in apps (Google & Microsoft)';
/** Unchanged route, so existing links and bookmarks keep working. */
export const SIGN_IN_APPS_HREF = '/platform/oauth-apps';

export type SignInAppsStatus = Record<OAuthProvider, boolean>;
export type SignInNotice = { text: string; action?: { label: string; href: string } };

/** The provider whose sign-in app an account kind ('microsoft-365') or template ('notion-mcp') needs; null for none. */
export function signInProvider(kindOrTemplate: string): OAuthProvider | null {
  if (kindOrTemplate === 'gdrive') return 'google';
  if (kindOrTemplate === 'microsoft-365' || kindOrTemplate === 'onedrive') return 'microsoft';
  return null;
}

export function providerName(p: OAuthProvider): string {
  return p === 'google' ? 'Google' : 'Microsoft';
}

/** Server side: whether each provider's app is configured, as booleans only. */
export function signInAppsStatus(isConfigured: (p: OAuthProvider) => boolean): SignInAppsStatus {
  return { google: isConfigured('google'), microsoft: isConfigured('microsoft') };
}

const SET_UP = { label: 'Set up the sign-in app', href: SIGN_IN_APPS_HREF };

/**
 * The caller's role, or `null` while it is still loading. With an unknown role no role-specific text is
 * rendered (neither the admin link nor "ask your admin"), so an admin never briefly sees the creator wording.
 */
export type KnownRole = Role | null;

/** The warning on a row whose provider app is missing: what is wrong, and the link (admins) or whom to ask. */
export function missingSignInAppNotice(kindOrTemplate: string, role: KnownRole): SignInNotice | null {
  const p = signInProvider(kindOrTemplate);
  if (!p) return null;
  const name = providerName(p);
  const text = `Can't connect yet: the ${name} sign-in app isn't set up.`;
  if (role === null) return { text };
  return role === 'admin' ? { text, action: SET_UP } : { text: `${text} Ask your admin to set up the ${name} sign-in app.` };
}

/**
 * In the add form, before adding: warn when the chosen kind's provider app is not KNOWN to be configured.
 * An unknown status (`null`, the list not loaded) counts as missing, the same rule as `addedNotice`.
 */
export function preAddNotice(kind: string, apps: SignInAppsStatus | null, role: KnownRole): SignInNotice | null {
  const p = signInProvider(kind);
  if (!p || apps?.[p] === true) return null;
  return missingSignInAppNotice(kind, role);
}

/**
 * Right after adding a connection: the next step when the provider app is missing, else null. An unknown
 * status (`null`, the list not loaded) counts as missing, so a row never looks finished by default.
 */
export function addedNotice(kind: string, apps: SignInAppsStatus | null, role: KnownRole): SignInNotice | null {
  const p = signInProvider(kind);
  if (!p || apps?.[p] === true) return null;
  const name = providerName(p);
  if (role === null) return { text: `Added. Next step: set up the ${name} sign-in app.` };
  return role === 'admin'
    ? { text: `Added. Next step: set up the ${name} sign-in app.`, action: SET_UP }
    : { text: `Added. Next step: ask your admin to set up the ${name} sign-in app.` };
}

/**
 * The ONE sign-in warning a row shows (never two for one connection): the row the caller just added says
 * "Added. Next step: …", any other row with a missing app says "Can't connect yet: …". It follows the row's
 * own server status, so it disappears once the app is configured or the connection is deleted.
 */
export function rowSignInNotice(
  row: { id: string; template: string; oauthAppConfigured: boolean },
  justAddedId: string | null,
  role: KnownRole,
): SignInNotice | null {
  if (row.oauthAppConfigured) return null;
  const p = signInProvider(row.template);
  if (!p) return null;
  return row.id === justAddedId ? addedNotice(row.template, { google: false, microsoft: false }, role) : missingSignInAppNotice(row.template, role);
}

/**
 * The text for the always-mounted polite live region after adding: the added row's own notice, "Added." when
 * nothing is missing, and empty before anything was added or once that connection is gone.
 */
export function addedAnnouncement(
  rows: { id: string; template: string; oauthAppConfigured: boolean }[] | null,
  justAddedId: string | null,
  role: KnownRole,
): string {
  if (!justAddedId) return '';
  const row = rows?.find((r) => r.id === justAddedId);
  if (!row) return '';
  return rowSignInNotice(row, justAddedId, role)?.text ?? 'Added.';
}

/**
 * The Microsoft 365 mail-send prerequisite. Only an admin gets the link: the page is admin-only, so anyone
 * else is told to ask their admin.
 */
export function entraNote(role: KnownRole): SignInNotice {
  if (role === 'admin') return { text: 'Requires Mail.ReadWrite and Mail.Send in your Entra app registration.', action: { label: SIGN_IN_APPS_NAME, href: SIGN_IN_APPS_HREF } };
  if (role === null) return { text: 'Requires Mail.ReadWrite and Mail.Send in the Microsoft sign-in app.' };
  return { text: 'Requires Mail.ReadWrite and Mail.Send: ask your admin to add the permissions in the Microsoft sign-in app.' };
}
