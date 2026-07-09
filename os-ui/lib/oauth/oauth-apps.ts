/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/infra/os-mirror';
import { putSecret, secretFingerprint, getSecretServerSide, type SecretRef } from '@/lib/infra/secrets';
import { type OAuthProvider, OAUTH_PROVIDERS } from './providers.ts';

/**
 * Admin OAuth-app registry — where the platform admin registers the Google Cloud
 * OAuth client and the Microsoft/Azure app the connected-drive flow federates to.
 * This is the SAME provider-key pattern as `lib/platform-admin/models.ts`:
 *
 *   THE ONE RULE — the client SECRET never lives in a record. The admin route
 *   writes it to Secrets Manager (`lib/secrets.putSecret`) and this registry keeps
 *   only { clientId (public), secretRef, fingerprint }. `getClientSecret()` reads
 *   it back SERVER-SIDE for the token exchange/refresh and never returns it to a
 *   client, a trace, or a log.
 *
 * In-process authoritative cache + best-effort OpenSearch mirror for durability,
 * so an admin configures the app once and it survives an os-ui restart.
 */

export type OAuthApp = {
  provider: OAuthProvider;
  /** The public OAuth client id (safe to display). */
  clientId: string;
  /** Reference into Secrets Manager for the client secret — NEVER the value. */
  secretRef: SecretRef;
  /** Non-reversible fingerprint of the stored client secret (display/audit only). */
  fingerprint: string;
  addedBy: string;
  addedAt: string;
};

type AppsState = { apps: Map<OAuthProvider, OAuthApp>; hydration: Promise<void> | null };
const APPS_KEY = Symbol.for('soa.oauth.apps');
function appsState(): AppsState {
  const g = globalThis as unknown as Record<symbol, AppsState | undefined>;
  if (!g[APPS_KEY]) g[APPS_KEY] = { apps: new Map(), hydration: null };
  return g[APPS_KEY]!;
}

// SECURITY: only clientId + ref + fingerprint are mirrored — never the secret value.
const mirror = osMirror({ index: 'os-oauth-apps' });

export async function ensureHydrated(): Promise<void> {
  const s = appsState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const docs = (await mirror.hydrate(50)) ?? [];
  const s = appsState();
  for (const doc of docs as OAuthApp[]) {
    if (doc?.provider && (doc.provider === 'google' || doc.provider === 'microsoft')) {
      s.apps.set(doc.provider, doc);
    }
  }
}

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

/**
 * Register (or replace) a provider's OAuth app. The RAW client secret is written
 * ONCE to Secrets Manager by the caller path here; this record keeps only the ref
 * + fingerprint. Returns the safe record (no secret).
 */
export function registerOAuthApp(input: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  addedBy: string;
}): OAuthApp {
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft') throw fail('Unknown OAuth provider', 400);
  const clientId = input.clientId.trim();
  if (!clientId) throw fail('A client id is required', 400);
  if (!input.clientSecret) throw fail('A client secret is required', 400);
  // Raw secret goes ONLY to Secrets Manager; the record keeps a reference.
  const ref = putSecret(`oauth-app-${provider}`, 'client_secret', input.clientSecret);
  const app: OAuthApp = {
    provider,
    clientId,
    secretRef: ref,
    fingerprint: secretFingerprint(ref),
    addedBy: input.addedBy,
    addedAt: new Date().toISOString(),
  };
  appsState().apps.set(provider, app);
  mirror.writeThrough(provider, app);
  return app;
}

/** The safe app record (clientId + fingerprint), or null when not configured. */
export function getOAuthApp(provider: OAuthProvider): OAuthApp | null {
  return appsState().apps.get(provider) ?? null;
}

export function isConfigured(provider: OAuthProvider): boolean {
  return appsState().apps.has(provider);
}

/** All configured apps for display — never the secret. */
export function listOAuthApps(): OAuthApp[] {
  return [...appsState().apps.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** SERVER-SIDE ONLY: the client id + secret for a token exchange/refresh. */
export function getClientCredentials(provider: OAuthProvider): { clientId: string; clientSecret: string } | null {
  const app = getOAuthApp(provider);
  if (!app) return null;
  const secret = getSecretServerSide(app.secretRef);
  if (!secret) return null;
  return { clientId: app.clientId, clientSecret: secret };
}

/** Provider metadata for the admin UI — label + the minimal scopes to register. */
export function providerCatalog(): { provider: OAuthProvider; label: string; scopes: string[]; configured: boolean }[] {
  return (Object.keys(OAUTH_PROVIDERS) as OAuthProvider[]).map((p) => ({
    provider: p,
    label: OAUTH_PROVIDERS[p].label,
    scopes: OAUTH_PROVIDERS[p].scopes,
    configured: isConfigured(p),
  }));
}

export function _reset(): void {
  const s = appsState();
  s.apps.clear();
  s.hydration = null;
  mirror.__reset();
}
