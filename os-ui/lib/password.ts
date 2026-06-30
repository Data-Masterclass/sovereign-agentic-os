/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
// Low-level crypto util: node:crypto makes this inherently server/Node-only
// (it cannot load in an Edge/browser bundle), so no `server-only` guard is
// needed — and omitting it keeps these primitives unit-testable under node:test.
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing + strength checking. Node's built-in scrypt (memory-hard KDF)
 * is used so there is NO native dependency (clean kind / Next standalone build)
 * while still being a real, salted, slow password hash — never plaintext.
 *
 * Stored format (self-describing, upgrade-safe):
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * `verifyPassword` is timing-safe. Plaintext passwords are never logged, never
 * persisted, and never returned to a client.
 */

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const N = 1 << 15; // 32768 — CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/** Hash a plaintext password. Returns the self-describing encoded string. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptWith(plain, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a plaintext password against a stored hash. Timing-safe, never throws. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const [, , , , saltB64, hashB64] = stored.split('$');
    if (!saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scryptWith(plain, salt);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True if a string looks like one of our scrypt hashes (not plaintext). */
export function isHashed(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

async function scryptWith(plain: string, salt: Buffer): Promise<Buffer> {
  // Node's scrypt requires maxmem high enough for N*r*128 bytes; bump it.
  // promisify drops the options arg, so call the raw form for the cost params.
  return new Promise<Buffer>((resolve, reject) => {
    _scrypt(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (err, dk) => {
      if (err) reject(err);
      else resolve(dk as Buffer);
    });
  });
}

// ---- Strength ---------------------------------------------------------------

export type Strength = { ok: boolean; score: number; reasons: string[] };

const MIN_LEN = 12;

// A tiny deny-list of the most obvious choices. Not exhaustive — the length +
// character-class rules do the heavy lifting; this just blocks the worst.
const COMMON = new Set([
  'password', 'passw0rd', 'admin', 'administrator', 'changeme', 'letmein',
  'welcome', 'qwerty', 'qwertyuiop', '111111', '123456', '12345678',
  '123456789', '1234567890', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'password1', 'admin123', 'root', 'toor', 'secret', 'sovereign',
]);

/**
 * Assess a candidate password. Server-authoritative — the UI mirrors these rules
 * for live feedback but the API re-checks before accepting any password.
 */
export function assessPasswordStrength(pw: string, username = ''): Strength {
  const reasons: string[] = [];
  const lower = pw.toLowerCase();

  if (pw.length < MIN_LEN) reasons.push(`Use at least ${MIN_LEN} characters`);
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));
  if (classes < 3) reasons.push('Mix upper, lower, numbers and symbols (3 of 4)');
  if (COMMON.has(lower)) reasons.push('That password is too common');
  if (username && lower.includes(username.trim().toLowerCase()) && username.trim().length >= 3)
    reasons.push('Do not include your username');
  if (/^(.)\1+$/.test(pw)) reasons.push('Avoid a single repeated character');

  // Score 0..4 for the UI meter.
  let score = 0;
  if (pw.length >= MIN_LEN) score++;
  if (pw.length >= 16) score++;
  score += Math.max(0, classes - 2);
  score = Math.min(4, score);

  return { ok: reasons.length === 0, score, reasons };
}
