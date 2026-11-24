/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Pluggable KEY PROVIDERS that wrap the data key of the connection-credential store
 * USER STORY: As the person installing the OS I choose where the master key lives — inside the OS
 *             (with a recovery key I keep offline), in STACKIT KMS, or (GitOps) in a vault through
 *             External Secrets — with a few clicks, and the stored credentials survive a restore.
 * ARCHITECTURE:
 *   - ENVELOPE ENCRYPTION. Connection credentials are sealed under a random DATA KEY (DEK,
 *     `key-manager.ts`). Only the DEK is ever handed to a provider, which WRAPS it with its MASTER
 *     key (KEK) and UNWRAPS it at boot. One interface, {@link KeyProvider}: id, wrap, unwrap, health.
 *   - `builtin` (default): the KEK is the deployment Secret `os-secrets-encryption-key`
 *     (OS_SECRETS_ENCRYPTION_KEY, chart-generated, excluded from Velero). AES-256-GCM under an HKDF
 *     sub-key. A lost cluster loses it — that is what the RECOVERY KEY (`key-recovery.ts`) is for.
 *   - `eso`: the same wrap, but the KEK Secret is written by External Secrets from STACKIT Secrets
 *     Manager (GitOps installs; the chart's externalSecrets.managed). The OS cannot see who wrote the
 *     env value; `scripts/smoke-test.sh` checks the cluster side.
 *   - `stackit`: STACKIT KMS over its REST API (the same routes the official, Apache-2.0
 *     stackit-sdk-go `services/kms/v1api` client calls — no SDK dependency in os-ui):
 *     POST {base}/v1/projects/{projectId}/regions/{region}/keyrings/{keyRingId}/keys/{keyId}/versions/{version}/encrypt|decrypt
 *     body/answer `{ data: <base64> }`, Bearer token (a STACKIT service-account access token).
 *     The ciphertext names the key version it was made with, so a KMS key rotation keeps old
 *     wraps readable.
 *   - `aws-kms`, `azure-key-vault`, `gcp-kms`: interface-ready STUBS. Selecting one fails with
 *     "not yet available" — never a silent fallback. Their official SDKs are permissive
 *     (@aws-sdk/client-kms Apache-2.0, @azure/keyvault-keys MIT, @google-cloud/kms Apache-2.0)
 *     and are added with the implementation. HashiCorp Vault (BSL) and OpenBao (MPL) are not offered.
 *   - BOOTSTRAP: a provider's OWN credential cannot be protected by the key it unlocks, so it is
 *     sealed under the builtin KEK (`sealProviderCredential`) and kept in the key record. Workload
 *     identity (no stored credential) is the better answer where a cloud offers it to pods.
 *   - Pure (no `server-only`, no Next imports); `fetch` is injected so every provider unit-tests
 *     against a mock. Never logs or returns a key, a DEK or a credential.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

export type KeyProviderId = 'builtin' | 'eso' | 'stackit' | 'aws-kms' | 'azure-key-vault' | 'gcp-kms';
export const KEY_PROVIDER_IDS: readonly KeyProviderId[] = ['builtin', 'eso', 'stackit', 'aws-kms', 'azure-key-vault', 'gcp-kms'];

export type ProviderHealth = { ok: boolean; state: 'ok' | 'unreachable' | 'denied' | 'misconfigured' | 'not-available'; detail: string };

export interface KeyProvider {
  readonly id: KeyProviderId;
  /** Wrap a data key; returns an opaque string (never the key). `keyId` binds the wrap to its DEK. */
  wrap(dataKey: Buffer, keyId: string): Promise<string>;
  /** Unwrap; throws {@link KeyProviderError} — never returns a guess. */
  unwrap(wrapped: string, keyId: string): Promise<Buffer>;
  /** A real round trip against the provider (wrap + unwrap of a throwaway key). */
  health(): Promise<ProviderHealth>;
  /** Optional: false when `wrapped` opens only with a RETIRED master key (re-wrap it under the current one). */
  isCurrent?(wrapped: string, keyId: string): boolean;
}

export type KeyProviderCode = 'not-available' | 'misconfigured' | 'unreachable' | 'denied' | 'unwrap-failed';
export class KeyProviderError extends Error {
  readonly code: KeyProviderCode;
  constructor(code: KeyProviderCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'KeyProviderError';
  }
}

/** What the admin console / install wizard show per provider: label, config fields, credential field. */
export type ProviderField = { name: string; label: string; placeholder?: string; required: boolean };
export type ProviderInfo = {
  id: KeyProviderId;
  label: string;
  available: boolean;
  summary: string;
  config: ProviderField[];
  /** The secret the provider needs (sealed under the builtin KEK), or null (none / workload identity). */
  credential: ProviderField | null;
  licence?: string;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'builtin', label: 'Built into the OS (recommended to start)', available: true,
    summary: 'The OS generates the master key and keeps it in the cluster (never in a backup). You save a one-time recovery key offline; with it, a restored or rebuilt cluster opens the stored credentials again.',
    config: [], credential: null,
  },
  {
    id: 'stackit', label: 'STACKIT Key Management Service', available: true,
    summary: 'The master key never leaves STACKIT KMS; the OS asks KMS to wrap and unwrap its data key. Needs a symmetric (aes_256_gcm) key and a service-account access token allowed to encrypt/decrypt with it.',
    config: [
      { name: 'projectId', label: 'Project ID', required: true },
      { name: 'region', label: 'Region', placeholder: 'eu01', required: true },
      { name: 'keyRingId', label: 'Key ring ID', required: true },
      { name: 'keyId', label: 'Key ID', required: true },
      { name: 'keyVersion', label: 'Key version', placeholder: '1', required: true },
      { name: 'endpoint', label: 'API endpoint (optional)', placeholder: 'https://kms.api.stackit.cloud', required: false },
    ],
    credential: { name: 'token', label: 'Service-account access token', required: true },
    licence: 'REST API (official client: stackit-sdk-go, Apache-2.0)',
  },
  {
    id: 'eso', label: 'External Secrets (GitOps installs)', available: true,
    summary: 'The master key Secret is written by External Secrets from STACKIT Secrets Manager (chart externalSecrets.managed). Choose this only when the deployment is managed by GitOps.',
    config: [], credential: null,
  },
  { id: 'aws-kms', label: 'AWS KMS', available: false, summary: 'Not yet available.', config: [{ name: 'keyArn', label: 'Key ARN', required: true }, { name: 'region', label: 'Region', required: true }], credential: null, licence: '@aws-sdk/client-kms (Apache-2.0)' },
  { id: 'azure-key-vault', label: 'Azure Key Vault', available: false, summary: 'Not yet available.', config: [{ name: 'keyUrl', label: 'Key URL', required: true }], credential: null, licence: '@azure/keyvault-keys (MIT)' },
  { id: 'gcp-kms', label: 'Google Cloud KMS', available: false, summary: 'Not yet available.', config: [{ name: 'keyName', label: 'Key resource name', required: true }], credential: null, licence: '@google-cloud/kms (Apache-2.0)' },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ------------------------------------------------------------------ AES-GCM helpers --

/** AES-256-GCM, `v1.<nonce>.<ct>.<tag>` (base64url). AAD binds the wrap to its purpose + key id. */
export function aesWrap(key: Buffer, plaintext: Buffer, aad: string): string {
  const n = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, n);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return ['v1', n.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

export function aesUnwrap(key: Buffer, wrapped: string, aad: string): Buffer {
  const [v, n, ct, tag] = String(wrapped).split('.');
  if (v !== 'v1' || !n || ct === undefined || !tag) throw new KeyProviderError('unwrap-failed', 'not a v1 wrap');
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(n, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  } catch {
    throw new KeyProviderError('unwrap-failed', 'authentication failed (another master key, or altered)');
  }
}

const HKDF_SALT = 'sovereign-agentic-os';
function kekFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, 'connection-keys/v1/kek', 32));
}

// --------------------------------------------------------------------- providers --

/**
 * builtin + eso: the KEK is OS_SECRETS_ENCRYPTION_KEY (chart-generated, or written by ESO). MASTER-KEY
 * ROTATION: retired values in OS_SECRETS_ENCRYPTION_KEY_PREVIOUS (comma-separated) still UNWRAP; the
 * key manager then re-wraps under the current key on its own (`isCurrent`).
 */
export function envKekProvider(id: 'builtin' | 'eso', secret: string | undefined, previous: string[] = []): KeyProvider {
  const raw = (secret ?? '').trim();
  const kek = () => {
    if (raw.length < 32) throw new KeyProviderError('misconfigured', 'OS_SECRETS_ENCRYPTION_KEY is missing or shorter than 32 characters');
    return kekFrom(raw);
  };
  const retired = previous.map((s) => s.trim()).filter((s) => s.length >= 32).map(kekFrom);
  const aad = (keyId: string) => `dek|${id}|${keyId}`;
  const p: KeyProvider = {
    id,
    async wrap(dek, keyId) {
      return aesWrap(kek(), dek, aad(keyId));
    },
    async unwrap(w, keyId) {
      try {
        return aesUnwrap(kek(), w, aad(keyId));
      } catch (e) {
        for (const k of retired) {
          try {
            return aesUnwrap(k, w, aad(keyId));
          } catch { /* next retired key */ }
        }
        throw e;
      }
    },
    isCurrent(w, keyId) {
      try {
        aesUnwrap(kek(), w, aad(keyId));
        return true;
      } catch {
        return false;
      }
    },
    health: () => roundTrip(p),
  };
  return p;
}

async function roundTrip(p: KeyProvider): Promise<ProviderHealth> {
  try {
    const probe = randomBytes(32);
    const back = await p.unwrap(await p.wrap(probe, 'health-probe'), 'health-probe');
    return back.equals(probe) ? { ok: true, state: 'ok', detail: 'wrap + unwrap round trip succeeded' } : { ok: false, state: 'misconfigured', detail: 'round trip returned another value' };
  } catch (e) {
    const code = e instanceof KeyProviderError ? e.code : 'unreachable';
    const state: ProviderHealth['state'] = code === 'not-available' ? 'not-available' : code === 'denied' ? 'denied' : code === 'misconfigured' ? 'misconfigured' : 'unreachable';
    return { ok: false, state, detail: e instanceof Error ? e.message : String(e) };
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
/** A KMS call never hangs a refresh pass: 10 s, then `unreachable`. */
export const PROVIDER_TIMEOUT_MS = 10_000;
/** The token is only ever sent to STACKIT's own API hosts — never to an endpoint an admin (or a tampered record) names. */
const STACKIT_ENDPOINT = /^https:\/\/([a-z0-9-]+\.)*stackit\.cloud$/;

export type StackitConfig = { projectId: string; region: string; keyRingId: string; keyId: string; keyVersion: string; endpoint?: string };

/** STACKIT KMS (REST; same routes as stackit-sdk-go services/kms/v1api). */
export function stackitKmsProvider(cfg: Partial<StackitConfig>, token: string | undefined, fetchImpl: FetchLike): KeyProvider {
  const missing = (['projectId', 'region', 'keyRingId', 'keyId', 'keyVersion'] as const).filter((k) => !String(cfg[k] ?? '').trim());
  const base = String(cfg.endpoint || 'https://kms.api.stackit.cloud').replace(/\/+$/, '');
  const seg = (s: unknown) => encodeURIComponent(String(s).trim());
  async function call(op: 'encrypt' | 'decrypt', version: string, data: string): Promise<string> {
    if (missing.length) throw new KeyProviderError('misconfigured', `STACKIT KMS: missing ${missing.join(', ')}`);
    if (!token) throw new KeyProviderError('misconfigured', 'STACKIT KMS: no service-account token (re-enter it under Platform → Encryption keys)');
    if (!STACKIT_ENDPOINT.test(base)) throw new KeyProviderError('misconfigured', 'STACKIT KMS: the endpoint must be an https://….stackit.cloud host');
    const url = `${base}/v1/projects/${seg(cfg.projectId)}/regions/${seg(cfg.region)}/keyrings/${seg(cfg.keyRingId)}/keys/${seg(cfg.keyId)}/versions/${seg(version)}/${op}`;
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ data }), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch (e) {
      throw new KeyProviderError('unreachable', `STACKIT KMS unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 401 || res.status === 403) throw new KeyProviderError('denied', `STACKIT KMS refused the token (${res.status}) — it needs encrypt/decrypt on this key`);
    if (res.status === 404) throw new KeyProviderError('misconfigured', 'STACKIT KMS: project, key ring, key or version not found (404)');
    if (res.status < 200 || res.status >= 300) throw new KeyProviderError(op === 'decrypt' && res.status === 400 ? 'unwrap-failed' : 'unreachable', `STACKIT KMS ${op} answered ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    if (typeof body?.data !== 'string') throw new KeyProviderError('unreachable', `STACKIT KMS ${op}: no data in the answer`);
    return body.data;
  }
  const p: KeyProvider = {
    id: 'stackit',
    async wrap(dek, keyId) {
      const version = String(cfg.keyVersion ?? '').trim();
      // AAD is not part of the KMS API: bind the key id INSIDE the plaintext instead.
      const pt = Buffer.concat([Buffer.from(`dek|${keyId}|`), dek]).toString('base64');
      return `stackit.${version}.${await call('encrypt', version, pt)}`;
    },
    async unwrap(w, keyId) {
      const m = String(w).match(/^stackit\.([^.]+)\.(.+)$/);
      if (!m) throw new KeyProviderError('unwrap-failed', 'not a STACKIT KMS wrap');
      const pt = Buffer.from(await call('decrypt', m[1], m[2]), 'base64');
      const prefix = Buffer.from(`dek|${keyId}|`);
      if (!pt.subarray(0, prefix.length).equals(prefix)) throw new KeyProviderError('unwrap-failed', 'STACKIT KMS returned a key for another data key id');
      return pt.subarray(prefix.length);
    },
    health: () => roundTrip(p),
  };
  return p;
}

/** Interface-ready providers that are not implemented yet: every call says so. */
export function unavailableProvider(id: 'aws-kms' | 'azure-key-vault' | 'gcp-kms'): KeyProvider {
  const no = () => new KeyProviderError('not-available', `${providerInfo(id)?.label ?? id} is not yet available as a key provider`);
  return {
    id,
    async wrap() { throw no(); },
    async unwrap() { throw no(); },
    async health() { return { ok: false, state: 'not-available', detail: no().message }; },
  };
}

export type ProviderDeps = { env: NodeJS.ProcessEnv; fetch: FetchLike };

/** Build the provider an id + config + (opened) credential describe. Unknown ids throw. */
export function createKeyProvider(id: string, config: Record<string, string>, credential: string | undefined, deps: ProviderDeps): KeyProvider {
  switch (id) {
    case 'builtin':
    case 'eso':
      return envKekProvider(id, deps.env.OS_SECRETS_ENCRYPTION_KEY, (deps.env.OS_SECRETS_ENCRYPTION_KEY_PREVIOUS ?? '').split(','));
    case 'stackit':
      return stackitKmsProvider(config as Partial<StackitConfig>, credential, deps.fetch);
    case 'aws-kms':
    case 'azure-key-vault':
    case 'gcp-kms':
      return unavailableProvider(id);
    default:
      throw new KeyProviderError('misconfigured', `unknown key provider '${id}'`);
  }
}

// ---------------------------------------------------- provider credential (bootstrap) --

/** The builtin master key and its retired values (OS_SECRETS_ENCRYPTION_KEY_PREVIOUS), current first. */
function builtinSecrets(env: NodeJS.ProcessEnv): string[] {
  const cur = (env.OS_SECRETS_ENCRYPTION_KEY ?? '').trim();
  const prev = (env.OS_SECRETS_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length >= 32);
  return cur.length >= 32 ? [cur, ...prev] : [];
}
const credKey = (secret: string) => Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, 'connection-keys/v1/provider-credential', 32));

/** Seal a provider's credential under the BUILTIN KEK — the one key that does not depend on a provider. */
export function sealProviderCredential(env: NodeJS.ProcessEnv, providerId: string, credential: string): string {
  const [cur] = builtinSecrets(env);
  if (!cur) throw new KeyProviderError('misconfigured', 'OS_SECRETS_ENCRYPTION_KEY is needed to protect the provider credential');
  return aesWrap(credKey(cur), Buffer.from(credential, 'utf8'), `cred|${providerId}`);
}

/** Open it — with the current builtin key, or a retired one during a master-key rotation. `current`: no re-seal needed. */
export function openProviderCredentialWith(env: NodeJS.ProcessEnv, providerId: string, sealed: string): { credential: string; current: boolean } {
  const keys = builtinSecrets(env);
  if (!keys.length) throw new KeyProviderError('misconfigured', 'OS_SECRETS_ENCRYPTION_KEY is needed to open the provider credential');
  for (let i = 0; i < keys.length; i++) {
    try {
      return { credential: aesUnwrap(credKey(keys[i]), sealed, `cred|${providerId}`).toString('utf8'), current: i === 0 };
    } catch { /* next key */ }
  }
  throw new KeyProviderError('unwrap-failed', 'the provider credential cannot be opened (sealed under a builtin master key this cluster no longer has) — re-enter it');
}

export function openProviderCredential(env: NodeJS.ProcessEnv, providerId: string, sealed: string): string {
  return openProviderCredentialWith(env, providerId, sealed).credential;
}

// ------------------------------------------------------------------ record integrity --

/**
 * MAC over the security-relevant fields of the key record, under a key derived from the builtin master
 * key: whoever can write Secrets in the conn-secrets namespace (or tamper with a backup) cannot swap the
 * recovery public key, point the KMS config elsewhere, or substitute data-key ids without it failing.
 */
export function recordMacMaterial(r: { provider: { id: string; config?: Record<string, string>; credential?: string }; recovery?: { id: string; salt: string; publicKey: string }; pendingRecovery?: { id: string; salt: string; publicKey: string }; dataKeys: { id: string; provider: string }[] }): string {
  const cfg = Object.fromEntries(Object.entries(r.provider.config ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const rec = (x?: { id: string; salt: string; publicKey: string }) => (x ? [x.id, x.salt, x.publicKey] : null);
  return JSON.stringify(['connection-keyring/v1', r.provider.id, cfg, r.provider.credential ?? '', rec(r.recovery), rec(r.pendingRecovery), r.dataKeys.map((k) => [k.id, k.provider])]);
}
const macKey = (secret: string) => Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, 'connection-keys/v1/record-mac', 32));

export function signRecordMac(env: NodeJS.ProcessEnv, material: string): string {
  const [cur] = builtinSecrets(env);
  if (!cur) throw new KeyProviderError('misconfigured', 'OS_SECRETS_ENCRYPTION_KEY is needed to sign the key record');
  return createHmac('sha256', macKey(cur)).update(material).digest('hex');
}

/** 'current' | 'previous' (signed under a retired builtin key — re-sign) | 'invalid'. */
export function verifyRecordMac(env: NodeJS.ProcessEnv, material: string, mac: string | undefined): 'current' | 'previous' | 'invalid' {
  if (!mac || !/^[0-9a-f]{64}$/.test(mac)) return 'invalid';
  const keys = builtinSecrets(env);
  for (let i = 0; i < keys.length; i++) {
    const want = createHmac('sha256', macKey(keys[i])).update(material).digest();
    if (timingSafeEqual(want, Buffer.from(mac, 'hex'))) return i === 0 ? 'current' : 'previous';
  }
  return 'invalid';
}
