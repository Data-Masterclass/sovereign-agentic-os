/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
// Low-level util: node:crypto makes this inherently server/Node-only (cannot
// load in an Edge/browser bundle), so no `server-only` guard is needed.
import { randomBytes } from 'node:crypto';

/**
 * Master recovery key generation + formatting.
 *
 * The key is high-entropy (20 bytes = 160 bits) rendered as Crockford base32 in
 * dash-separated groups so it can be read back from the downloaded file. The
 * SERVER ONLY EVER STORES A scrypt HASH of it (see lib/users.ts setRecoveryKey);
 * the plaintext is shown/downloaded exactly once and never persisted server-side.
 * Lose it → locked out. That is the documented trade-off.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I,L,O,U)

/** Generate a fresh plaintext master key, e.g. "K7Q2-9FMA-...". */
export function generateMasterKey(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  // Group into 4-char blocks for readability.
  return (out.match(/.{1,4}/g) ?? [out]).join('-');
}

/** Normalise user-entered key for comparison (strip dashes/space, upper-case). */
export function normalizeMasterKey(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** A friendly, downloadable recovery file body. */
export function recoveryFileBody(key: string, deployment: string): string {
  const when = new Date().toISOString();
  return [
    'SOVEREIGN AGENTIC OS — ACCOUNT RECOVERY KEY',
    '===========================================',
    '',
    `Deployment : ${deployment}`,
    `Generated  : ${when}`,
    '',
    'MASTER RECOVERY KEY (store this somewhere safe and OFFLINE):',
    '',
    `    ${key}`,
    '',
    'WHAT IT IS',
    '  This key can reset the password of any account on this deployment.',
    '  Use it on the /recover page if an administrator is ever locked out.',
    '',
    'IMPORTANT',
    '  * This is the ONLY copy. The server stores only a one-way hash of it.',
    '  * Anyone with this key can regain admin access — treat it like a root',
    '    password. Keep it offline (password manager / printed in a safe).',
    '  * If you lose it, it CANNOT be recovered. Generate a new one while you',
    '    are still signed in as an admin (Settings -> Users) to rotate it.',
    '',
  ].join('\n');
}
