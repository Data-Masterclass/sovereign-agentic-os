/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Admin OAuth-app registry — the Google and Microsoft apps the drive connections use
 * USER STORY: As a platform admin I want to register the Google Cloud OAuth client and the Azure
 *             app once so that users can connect their own drives.
 * ARCHITECTURE:
 *   - Server-only. The client secret is written to Secrets Manager (`@core/infra/secrets`
 *     `putSecret`); the record keeps only the public client id, the secret ref and a fingerprint.
 *   - `getClientCredentials()` reads the secret back server-side for `client.ts`; it is never
 *     returned to a client, a trace or a log. Same pattern as `tabs/admin/lib/models.ts`.
 *   - In-process cache plus a best-effort OpenSearch mirror (`os-oauth-apps`), so the
 *     configuration survives an os-ui restart. Written by `/api/platform-admin/oauth-apps`.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { putSecret, secretFingerprint, getSecretServerSide, hasSecret, awaitSecretWrites, secretStoreReady, type SecretRef } from '@core/infra/secrets';
import { type OAuthProvider, OAUTH_PROVIDERS } from '@core/auth/providers';

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
export async function registerOAuthApp(input: {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  addedBy: string;
}): Promise<OAuthApp> {
  const provider = input.provider;
  if (provider !== 'google' && provider !== 'microsoft') throw fail('Unknown OAuth provider', 400);
  const clientId = input.clientId.trim();
  if (!clientId) throw fail('A client id is required', 400);
  if (!input.clientSecret) throw fail('A client secret is required', 400);
  // Raw secret goes ONLY to Secrets Manager; the record keeps a reference.
  const ref = putSecret(`oauth-app-${provider}`, 'client_secret', input.clientSecret);
  // Durable before the app is reported as configured: a secret that only lives in this process would
  // vanish on the next restart and every drive connection would then fail its token exchange.
  await awaitSecretWrites([ref]);
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

/**
 * Configured apps whose client secret is no longer in the credential store (lost before credentials
 * were durable). Only meaningful once the store is loaded. Provider + client id only — never a value.
 */
export function listOAuthAppsMissingSecret(): { provider: OAuthProvider; clientId: string; addedBy: string }[] {
  if (!secretStoreReady()) return [];
  return listOAuthApps().filter((a) => a.secretRef?.name && !hasSecret(a.secretRef)).map((a) => ({ provider: a.provider, clientId: a.clientId, addedBy: a.addedBy }));
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
