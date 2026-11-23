/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App-side encryption for stored connection credentials (AES-256-GCM) + keyed fingerprints
 * USER STORY: As an operator I want every connection credential the OS stores to be ciphertext wherever
 *             it lands (a Kubernetes Secret, an etcd snapshot, a Velero backup), so the safety of a
 *             customer's API token never depends on whether the cluster encrypts etcd at rest.
 * ARCHITECTURE:
 *   - The key is a deployment secret (`OS_SECRETS_ENCRYPTION_KEY`, >= 32 chars; the chart's
 *     `os-secrets-encryption-key` Secret, generated once and preserved by `lookup`). Three keys are
 *     DERIVED from it with HKDF: the AES-256-GCM key, a public key id (stored next to every
 *     ciphertext, says nothing about the key), and the HMAC key for fingerprints. Same pattern as
 *     `agent-system-keys.ts`, different HKDF labels, so the two never share key material.
 *   - ROTATION READY: `OS_SECRETS_ENCRYPTION_KEY_PREVIOUS` (comma-separated) holds retired keys that may
 *     still DECRYPT; new writes always seal under the current key. Nothing is ever rotated silently —
 *     a value sealed under a key the pod no longer holds is reported as unreadable, never guessed at.
 *   - AAD binds a ciphertext to its own `name/key` ref: a sealed value copied onto another ref fails.
 *   - Fingerprints are HMAC-SHA256 under a server key (not an unsalted hash): a fingerprint shown in
 *     the UI can no longer be used to test guesses of a short credential offline.
 *   - Pure (no `server-only`, no Next imports): unit-testable under `node --test`. Never logs a value.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';

export const SECRETS_KEY_ENV = 'OS_SECRETS_ENCRYPTION_KEY';
export const SECRETS_PREVIOUS_KEYS_ENV = 'OS_SECRETS_ENCRYPTION_KEY_PREVIOUS';
const MIN_SECRET_LENGTH = 32;
const HKDF_SALT = 'sovereign-agentic-os';

export type SecretKey = { id: string; enc: Buffer; mac: Buffer };
export type Keyring = { current: SecretKey; previous: SecretKey[]; ephemeral: boolean };

export type SecretCryptoCode = 'no-key' | 'short-key' | 'unknown-key' | 'tampered' | 'malformed';
export class SecretCryptoError extends Error {
  readonly code: SecretCryptoCode;
  constructor(code: SecretCryptoCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SecretCryptoError';
  }
}

export function deriveSecretKey(secret: string): SecretKey {
  if (secret.length < MIN_SECRET_LENGTH) throw new SecretCryptoError('short-key', `${SECRETS_KEY_ENV} must be at least ${MIN_SECRET_LENGTH} characters`);
  const h = (info: string, len: number) => Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, info, len));
  return {
    enc: h('connection-secrets/v1/encrypt', 32),
    id: h('connection-secrets/v1/id', 8).toString('hex'),
    mac: h('connection-secrets/v1/fingerprint', 32),
  };
}

/**
 * The keyring from the environment. `allowEphemeral` (the in-memory backend only — local dev and
 * tests, where nothing outlives the process anyway) mints a random per-process key when none is set.
 * The durable backend never gets one: a missing key there is a hard, named failure.
 */
export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env, allowEphemeral = false): Keyring {
  const raw = (env[SECRETS_KEY_ENV] ?? '').trim();
  const previous = (env[SECRETS_PREVIOUS_KEYS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(deriveSecretKey);
  if (!raw) {
    if (!allowEphemeral) throw new SecretCryptoError('no-key', `${SECRETS_KEY_ENV} is not set — connection credentials cannot be encrypted`);
    return { current: deriveSecretKey(randomBytes(48).toString('base64')), previous, ephemeral: true };
  }
  return { current: deriveSecretKey(raw), previous, ephemeral: false };
}

const aad = (name: string, key: string) => Buffer.from(`connection-secret/v1|${name}|${key}`);

type Envelope = { v: 1; kid: string; n: string; c: string; t: string };

/** Seal a value for one ref. Returns an opaque string (JSON envelope) — ciphertext only. */
export function sealSecret(ring: Keyring, name: string, key: string, value: string): string {
  const k = ring.current;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k.enc, nonce);
  cipher.setAAD(aad(name, key));
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const env: Envelope = { v: 1, kid: k.id, n: nonce.toString('base64'), c: ct.toString('base64'), t: cipher.getAuthTag().toString('base64') };
  return JSON.stringify(env);
}

/** Open a sealed value for its ref. Throws {@link SecretCryptoError} — never returns a guess. */
export function openSecret(ring: Keyring, name: string, key: string, sealed: string): string {
  let e: Envelope;
  try {
    e = JSON.parse(sealed) as Envelope;
  } catch {
    throw new SecretCryptoError('malformed', 'sealed value is not an envelope');
  }
  if (!e || e.v !== 1 || typeof e.kid !== 'string' || typeof e.n !== 'string' || typeof e.c !== 'string' || typeof e.t !== 'string') {
    throw new SecretCryptoError('malformed', 'sealed value is not a v1 envelope');
  }
  const k = [ring.current, ...ring.previous].find((x) => x.id === e.kid);
  if (!k) throw new SecretCryptoError('unknown-key', `sealed under key id ${e.kid}, which this pod does not hold`);
  try {
    const d = createDecipheriv('aes-256-gcm', k.enc, Buffer.from(e.n, 'base64'));
    d.setAAD(aad(name, key));
    d.setAuthTag(Buffer.from(e.t, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.c, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new SecretCryptoError('tampered', 'authentication failed (altered ciphertext, or a value moved from another ref)');
  }
}

/** A keyed, non-reversible fingerprint (HMAC-SHA256 under the server key) — safe to show/audit. */
export function fingerprintSecret(ring: Keyring, value: string): string {
  return `hmac-sha256:${createHmac('sha256', ring.current.mac).update(value, 'utf8').digest('hex').slice(0, 16)}`;
}
