/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { config } from '@/lib/core/config';
import type { ForgejoAdminClient, MintedForgejoToken } from './forgejo-admin.ts';

/**
 * The REAL fetch-backed Forgejo ADMIN client for the per-user token-mint lane.
 * Server-only: it reads `config.forgejo*` (the mounted admin secret + in-cluster
 * Forgejo Service URL) and never reaches the browser. It reuses the EXACT basic-auth
 * `/api/v1` request shape the mirror/Build clients use — no second HTTP client.
 *
 * SECRET HYGIENE: the admin credential rides only in the request `authorization`
 * header; the minted token value is read from the create response and returned to
 * the caller UNMODIFIED. Nothing here logs the admin cred or a token — not on the
 * happy path, not in an error (errors carry only status codes + the API path/name).
 */

async function withTimeout(url: string, init: RequestInit, ms = 4000, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function adminAuth(): string {
  return 'Basic ' + Buffer.from(`${config.forgejoUser}:${config.forgejoPassword}`).toString('base64');
}

export function realForgejoAdmin(fetchImpl: typeof fetch = fetch): ForgejoAdminClient {
  const post = (path: string, body: unknown): Promise<Response | null> =>
    withTimeout(`${config.forgejoUrl}/api/v1${path}`, {
      method: 'POST',
      headers: { authorization: adminAuth(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 4000, fetchImpl);

  return {
    async ensureUser(username, email) {
      // Admin create-user. The API requires a password, but the account is
      // SSO/token-only: we generate a HIGH-ENTROPY throwaway, never store/return/log
      // it, and no flow ever logs in with it (auth is minted-token-only). A 4xx that
      // means "already exists" (409/422) is the idempotent no-op.
      const throwaway = randomPassword();
      const res = await post('/admin/users', {
        username,
        email,
        password: throwaway,
        must_change_password: false,
        visibility: 'private',
        // Do not send the throwaway to the user; there is no notification path.
        send_notify: false,
      });
      if (!res) throw new Error(`Forgejo ensureUser(${username}) failed (unreachable)`);
      if (res.ok) return;
      // Already-exists is success (idempotent). Forgejo returns 422 with a
      // "user already exists" message; some versions 409. Anything else is a real error.
      if (res.status === 409 || res.status === 422) return;
      throw new Error(`Forgejo ensureUser(${username}) failed (${res.status})`);
    },

    async createToken(username, name, scopes): Promise<MintedForgejoToken> {
      // Mint AS the user via admin `sudo`. Gitea/Forgejo honours the `sudo` header on
      // token creation so an admin mints on the target user's behalf without their
      // password. The response's `sha1` is the opaque token value.
      const res = await withTimeout(`${config.forgejoUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`, {
        method: 'POST',
        headers: { authorization: adminAuth(), accept: 'application/json', 'content-type': 'application/json', sudo: username },
        body: JSON.stringify({ name, scopes }),
      }, 4000, fetchImpl);
      if (!res || !res.ok) throw new Error(`Forgejo createToken(${username}) failed (${res?.status ?? 'unreachable'})`);
      const d = (await res.json().catch(() => null)) as { sha1?: string; name?: string } | null;
      if (!d || typeof d.sha1 !== 'string' || d.sha1.length === 0) {
        throw new Error(`Forgejo createToken(${username}) returned no token`);
      }
      return { name: String(d.name ?? name), value: d.sha1 };
    },

    async deleteTokensByPrefix(username, namePrefix): Promise<{ deleted: number }> {
      const list = await withTimeout(`${config.forgejoUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`, {
        method: 'GET',
        headers: { authorization: adminAuth(), accept: 'application/json', sudo: username },
      }, 4000, fetchImpl);
      if (!list) throw new Error(`Forgejo deleteTokensByPrefix(${username}) failed (unreachable)`);
      if (list.status === 404) return { deleted: 0 };
      if (!list.ok) throw new Error(`Forgejo deleteTokensByPrefix(${username}) list failed (${list.status})`);
      const tokens = (await list.json().catch(() => null)) as { name?: string }[] | null;
      if (!Array.isArray(tokens)) return { deleted: 0 };
      let deleted = 0;
      for (const t of tokens) {
        const tokenName = String(t?.name ?? '');
        if (!tokenName.startsWith(namePrefix)) continue;
        const del = await withTimeout(
          `${config.forgejoUrl}/api/v1/users/${encodeURIComponent(username)}/tokens/${encodeURIComponent(tokenName)}`,
          { method: 'DELETE', headers: { authorization: adminAuth(), accept: 'application/json', sudo: username } },
          4000,
          fetchImpl,
        );
        if (del && (del.ok || del.status === 404)) deleted += 1;
        // A single delete failure is swallowed: a stale token must not block a fresh mint.
      }
      return { deleted };
    },
  };
}

/** A high-entropy throwaway password for SSO/token-only account creation. Never
 *  stored, returned, or logged — it exists only to satisfy Forgejo's create-user
 *  schema for an account that authenticates by minted token alone. */
function randomPassword(): string {
  return `${randomUUID()}${randomUUID()}`;
}
