/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OS personal access tokens — the credential an engineer's git client presents
 * USER STORY: As a data or AI engineer I want to create a personal access token in the OS, use it
 *             to `git clone`/`git push` my domain's repository from VS Code, see only its prefix
 *             afterwards, and revoke it — so the engineer's door uses a real credential that maps
 *             to my real OS identity and never sits in plaintext anywhere (E-R2.1 … E-R2.3).
 * ARCHITECTURE:
 *   - PURE token format + hashing. No I/O, no store, no session: `access-tokens-store.ts` owns the
 *     records and the durable mirror, and `app/api/git/*` owns the HTTP. Keeping the format pure is
 *     what lets the no-leak test assert on strings without a cluster.
 *   - Format `sos_<prefix>_<secret>`: `prefix` (12 hex chars) is the PUBLIC lookup handle stored in
 *     the clear; `secret` is 32 crypto-random bytes, base64url. The prefix is what a list shows.
 *   - HASHED AT REST, sha256 over the WHOLE token string. A slow KDF (scrypt, as
 *     `core/kernel/password.ts` uses for human passwords) buys nothing here: the secret is 256 bits
 *     of `randomBytes`, so there is no guessable input to grind — and a `git push` would pay the
 *     KDF on every request. Comparison is `timingSafeEqual` on the digests.
 *   - The plaintext token exists exactly once, in the create response. Nothing in this module
 *     logs, throws or returns it; `redact()` is the scrubber every error path runs through, the
 *     same discipline `git-store.ts` `scrub()` applies to a mirror token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The visible marker of an OS personal access token. Greppable on purpose. */
export const TOKEN_PREFIX = 'sos';

/** Hex characters in the public lookup handle. */
export const HANDLE_LEN = 12;

/** `sos_<12 hex>_<43 base64url>` — the only shape `parseAccessToken` accepts. */
export const TOKEN_RE = new RegExp(`^${TOKEN_PREFIX}_([0-9a-f]{${HANDLE_LEN}})_([A-Za-z0-9_-]{32,64})$`);

export type MintedToken = {
  /** The plaintext token. Shown to the user ONCE and never stored. */
  token: string;
  /** The public lookup handle (stored in the clear, safe to display and log). */
  prefix: string;
  /** `sha256$<hex>` of the whole token string — this is what is stored. */
  hash: string;
};

/** A new token's plaintext plus the two values a record keeps. */
export function mintToken(): MintedToken {
  const prefix = randomBytes(Math.ceil(HANDLE_LEN / 2)).toString('hex').slice(0, HANDLE_LEN);
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}_${prefix}_${secret}`;
  return { token, prefix, hash: hashToken(token) };
}

/** `sha256$<hex>` of a token string. Deterministic; the stored form. */
export function hashToken(token: string): string {
  return `sha256$${createHash('sha256').update(String(token), 'utf8').digest('hex')}`;
}

/** True iff `value` is one of our stored hashes rather than a token (never plaintext at rest). */
export function isTokenHash(value: string | undefined | null): boolean {
  return typeof value === 'string' && /^sha256\$[0-9a-f]{64}$/.test(value);
}

/** The public handle of a presented token, or null when the string is not token-shaped. */
export function parseAccessToken(presented: string | undefined | null): { prefix: string } | null {
  const m = TOKEN_RE.exec(String(presented ?? '').trim());
  return m ? { prefix: m[1] } : null;
}

/** Timing-safe comparison of a presented token against a stored hash. Never throws. */
export function tokenMatches(presented: string, storedHash: string): boolean {
  try {
    if (!isTokenHash(storedHash)) return false;
    const a = Buffer.from(hashToken(presented));
    const b = Buffer.from(storedHash);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Replace every token-shaped substring with `sos_<prefix>_***`. Every message this module's
 * callers emit — a log line, an HTTP error, a push rejection on a developer's terminal — goes
 * through this, so a token pasted into the wrong field can never be echoed back (E-R2.3).
 */
export function redact(text: string): string {
  return String(text ?? '').replace(
    new RegExp(`${TOKEN_PREFIX}_([0-9a-f]{${HANDLE_LEN}})_[A-Za-z0-9_-]{8,64}`, 'g'),
    `${TOKEN_PREFIX}_$1_***`,
  );
}

/**
 * The credential a git client presents. `Authorization: Basic base64(<anything>:<token>)` is what
 * `git` sends for an HTTPS remote (the username is ignored — the token IS the principal), and
 * `Bearer <token>` is accepted for a scripted client. Returns the raw token or null; the caller
 * resolves it through the store.
 */
export function tokenFromAuthorization(header: string | undefined | null): string | null {
  const h = String(header ?? '').trim();
  if (!h) return null;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (basic) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) return parseAccessToken(decoded) ? decoded : null;
    const user = decoded.slice(0, colon);
    const pass = decoded.slice(colon + 1);
    // Either half may carry it: `git` puts the token in the password, a human may paste it as the
    // username with an empty password.
    if (parseAccessToken(pass)) return pass;
    if (parseAccessToken(user)) return user;
    return null;
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(h);
  if (bearer && parseAccessToken(bearer[1])) return bearer[1];
  return null;
}
