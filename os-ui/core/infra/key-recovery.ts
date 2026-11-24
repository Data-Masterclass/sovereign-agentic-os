/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one-time RECOVERY KEY that opens the connection credentials when the master key is gone
 * USER STORY: As the person who installed the OS I save one recovery key offline; if the cluster is
 *             lost and restored from backup, I type it in and every stored credential is readable again.
 * ARCHITECTURE:
 *   - The recovery key is 200 random bits shown ONCE as 8 groups of 5 base32 characters
 *     (`ABCDE-FGHIJ-…`). It is NEVER stored server-side. scrypt(key, salt) gives a 32-byte seed; the
 *     seed is an X25519 PRIVATE key. Only its PUBLIC key is stored — that is the VERIFIER: a typed key
 *     is right exactly when it derives the same public key.
 *   - Every data key is ALSO wrapped to that public key (ECIES: ephemeral X25519 + HKDF-SHA256 +
 *     AES-256-GCM). Because wrapping needs only the public key, a rotation or a provider switch keeps
 *     the new data key recoverable without asking for the recovery key again; unwrapping needs the
 *     private key, i.e. the recovery key.
 *   - Pure (node:crypto only); unit-tested in key-manager.test.ts. Never logs a key.
 */
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, type KeyObject } from 'crypto';
import { aesUnwrap, aesWrap, KeyProviderError } from '@core/infra/key-providers';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** A new recovery key: 40 symbols × 5 bits = 200 bits, in 8 groups of 5. */
export function newRecoveryKey(): string {
  const bytes = randomBytes(40);
  const chars = [...bytes].map((b) => ALPHABET[b & 31]);
  return Array.from({ length: 8 }, (_, i) => chars.slice(i * 5, i * 5 + 5).join('')).join('-');
}

/** Normalise what a person typed: case, spaces and dashes do not matter. */
export function normaliseRecoveryKey(typed: string): string {
  return String(typed ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

function privateFrom(recoveryKey: string, salt: string): KeyObject {
  const norm = normaliseRecoveryKey(recoveryKey);
  if (norm.length !== 40 || [...norm].some((c) => !ALPHABET.includes(c))) {
    throw new KeyProviderError('unwrap-failed', 'that is not a recovery key (8 groups of 5 characters)');
  }
  const seed = scryptSync(norm, Buffer.from(salt, 'base64'), 32, SCRYPT);
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

const rawPublic = (k: KeyObject) => createPublicKey(k).export({ format: 'der', type: 'spki' }).toString('base64');

/** What is stored for a recovery key: salt + public key (the verifier). */
export type RecoveryVerifier = { salt: string; publicKey: string };

export function recoveryVerifier(recoveryKey: string): RecoveryVerifier {
  const salt = randomBytes(16).toString('base64');
  return { salt, publicKey: rawPublic(privateFrom(recoveryKey, salt)) };
}

/** True when the typed key is the one the verifier was made from. */
export function recoveryKeyMatches(v: RecoveryVerifier, typed: string): boolean {
  try {
    return rawPublic(privateFrom(typed, v.salt)) === v.publicKey;
  } catch {
    return false;
  }
}

function sharedKey(priv: KeyObject, pub: KeyObject, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: priv, publicKey: pub }), 'sovereign-agentic-os', info, 32));
}

/** Wrap a data key to the recovery PUBLIC key (no recovery key needed). */
export function wrapForRecovery(v: RecoveryVerifier, dek: Buffer, keyId: string): string {
  const eph = generateKeyPairSync('x25519');
  const recPub = createPublicKey({ key: Buffer.from(v.publicKey, 'base64'), format: 'der', type: 'spki' });
  const k = sharedKey(eph.privateKey, recPub, `connection-keys/v1/recovery|${keyId}`);
  return `${rawPublic(eph.privateKey)}~${aesWrap(k, dek, `recovery|${keyId}`)}`;
}

/** Unwrap with the recovery key. Throws when the key is wrong or the wrap altered. */
export function unwrapWithRecovery(v: RecoveryVerifier, typed: string, wrapped: string, keyId: string): Buffer {
  if (!recoveryKeyMatches(v, typed)) throw new KeyProviderError('unwrap-failed', 'the recovery key does not match');
  const [ephPub, w] = String(wrapped).split('~');
  if (!ephPub || !w) throw new KeyProviderError('unwrap-failed', 'not a recovery wrap');
  const priv = privateFrom(typed, v.salt);
  const k = sharedKey(priv, createPublicKey({ key: Buffer.from(ephPub, 'base64'), format: 'der', type: 'spki' }), `connection-keys/v1/recovery|${keyId}`);
  return aesUnwrap(k, w, `recovery|${keyId}`);
}
