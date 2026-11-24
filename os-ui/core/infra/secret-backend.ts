/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where sealed connection credentials are kept — one small interface, two backends
 * USER STORY: As a user I connect a system once and the connection keeps working after the OS
 *             restarts, and agent runs in the worker can use it too; as a maintainer I want to move the
 *             store to STACKIT Secrets Manager later by writing ONE new backend, not by touching ~30 callers.
 * ARCHITECTURE:
 *   - `SecretBackend` stores SEALED values only (`secret-crypto.ts` ciphertext): list / read / write /
 *     remove. Cache, hydration, write-through and health live in `secrets.ts`; a backend is storage.
 *   - VERSIONED, CONDITIONAL WRITES. Every record carries the backend's own `version` (the Kubernetes
 *     `resourceVersion`; a counter in memory). `write(rec, expected)`: `expected === null` = create only
 *     (exists → conflict); a string = replace only that version (changed or deleted → conflict). A
 *     conflict throws {@link SecretConflictError}; the store decides (adopt the other writer's value, or
 *     re-read and overwrite). No wall clocks are compared anywhere.
 *   - `kubernetesSecretBackend`: one Kubernetes Secret per `name/key` ref in a DEDICATED namespace
 *     (`<release>-conn-secrets` by default, chart `osUI.connectionSecrets.namespace`), so the os-ui and
 *     os-ui-worker ServiceAccounts hold Secret rights there and none in the release namespace. Labels
 *     `app.kubernetes.io/managed-by=os-ui`, `app.kubernetes.io/component=connection-secret`,
 *     `os.connection-id=<ref name>`; the ref in annotations; the ciphertext in `data.sealed`. Uses the
 *     in-cluster client (`k8s.ts`, injected so it unit-tests against a fake). List is label-selected and
 *     paginated (`continue`).
 *   - `memorySecretBackend`: a Map. Local dev and tests only, selected explicitly (`OS_SECRETS_BACKEND`)
 *     or because the process is not in a cluster — never as a fallback for a failing cluster.
 *   - Every failure throws `SecretBackendError` with the API status — never a value.
 */
import { createHash } from 'crypto';

export type SecretRefLike = { name: string; key: string };
/** One stored credential: its ref, the sealed value (ciphertext envelope), and the backend's version. */
export type SealedRecord = { name: string; key: string; sealed: string; version: string };

export interface SecretBackend {
  readonly kind: 'memory' | 'kubernetes';
  /** Every stored record. Throws {@link SecretBackendError} when the store cannot be read. */
  list(): Promise<SealedRecord[]>;
  /** One record, or null when absent. */
  read(ref: SecretRefLike): Promise<SealedRecord | null>;
  /** Conditional write (see the header); returns the new version. */
  write(rec: Omit<SealedRecord, 'version'>, expected: string | null): Promise<{ version: string }>;
  /** Delete by name (absent is fine). */
  remove(ref: SecretRefLike): Promise<void>;
}

export class SecretBackendError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'SecretBackendError';
  }
}

/** The record changed (or appeared / disappeared) since the version the writer expected. */
export class SecretConflictError extends SecretBackendError {
  constructor(message: string) {
    super(409, message);
    this.name = 'SecretConflictError';
  }
}

// --------------------------------------------------------------------------- memory --

/** In-process store. Pass a shared Map to simulate two processes reading one store (tests). */
export function memorySecretBackend(store: Map<string, SealedRecord> = new Map()): SecretBackend & { store: Map<string, SealedRecord> } {
  const k = (r: SecretRefLike) => `${r.name}/${r.key}`;
  let counter = Math.max(0, ...[...store.values()].map((r) => Number(r.version) || 0));
  return {
    kind: 'memory',
    store,
    async list() {
      return [...store.values()].map((r) => ({ ...r }));
    },
    async read(ref) {
      const r = store.get(k(ref));
      return r ? { ...r } : null;
    },
    async write(rec, expected) {
      const cur = store.get(k(rec));
      if (expected === null ? cur !== undefined : cur?.version !== expected) throw new SecretConflictError(`${k(rec)} changed`);
      const version = String(++counter);
      store.set(k(rec), { ...rec, version });
      return { version };
    },
    async remove(ref) {
      store.delete(k(ref));
    },
  };
}

// ----------------------------------------------------------------------- kubernetes --

export type K8sCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

export const SECRET_LABELS = {
  'app.kubernetes.io/managed-by': 'os-ui',
  'app.kubernetes.io/component': 'connection-secret',
} as const;
export const CONNECTION_ID_LABEL = 'os.connection-id';
const ANN_NAME = 'sovereign-os.io/secret-ref-name';
const ANN_KEY = 'sovereign-os.io/secret-ref-key';
const NAME_PREFIX = 'os-conn-secret-';
/** Kubernetes caps a Secret at 1 MiB; leave room for metadata and the envelope's base64. */
export const MAX_SECRET_VALUE_BYTES = 256 * 1024;

function slug(s: string, max: number): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}

/**
 * The Kubernetes object name for a ref: DNS-1123, <= 63 chars, readable prefix plus a hash of the
 * exact ref, so two refs that slug alike never collide.
 */
export function k8sSecretName(ref: SecretRefLike): string {
  const hash = createHash('sha256').update(`${ref.name}\u0000${ref.key}`).digest('hex').slice(0, 16);
  const readable = slug(`${ref.name}-${ref.key}`, 63 - NAME_PREFIX.length - 17);
  return `${NAME_PREFIX}${readable ? `${readable}-` : ''}${hash}`;
}

/** A label-value-safe form of the ref name (<= 63, alnum at both ends). */
export function connectionIdLabel(refName: string): string {
  const v = refName.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return v || 'unnamed';
}

const ok = (s: number) => s >= 200 && s < 300;

function fail(op: string, status: number, body: Record<string, unknown>): SecretBackendError {
  const why = status === 0 ? 'the Kubernetes API is unreachable (no in-cluster ServiceAccount, or network)'
    : status === 401 || status === 403 ? `this pod's ServiceAccount is not allowed to ${op} Secrets in the connection-secrets namespace (chart Role os-ui-connection-secrets)`
      : `the Kubernetes API answered ${status}`;
  const msg = typeof body?.message === 'string' ? `: ${String(body.message).slice(0, 200)}` : '';
  return new SecretBackendError(status, `connection-secret store: cannot ${op} — ${why}${msg}`);
}

type K8sObj = { metadata?: { resourceVersion?: string; annotations?: Record<string, string> }; data?: Record<string, string> };

function toRecord(it: K8sObj): SealedRecord | null {
  const ann = it.metadata?.annotations ?? {};
  const data = it.data ?? {};
  if (!ann[ANN_NAME] || !ann[ANN_KEY] || typeof data.sealed !== 'string') return null;
  return { name: ann[ANN_NAME], key: ann[ANN_KEY], version: String(it.metadata?.resourceVersion ?? ''), sealed: Buffer.from(data.sealed, 'base64').toString('utf8') };
}

export function kubernetesSecretBackend(opts: { namespace: string; k8s: K8sCall }): SecretBackend {
  const { namespace: ns, k8s } = opts;
  const base = `/api/v1/namespaces/${encodeURIComponent(ns)}/secrets`;
  const selector = Object.entries(SECRET_LABELS).map(([k, v]) => `${k}=${v}`).join(',');

  function manifest(rec: Omit<SealedRecord, 'version'>, resourceVersion?: string) {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: k8sSecretName(rec),
        namespace: ns,
        ...(resourceVersion ? { resourceVersion } : {}),
        labels: { ...SECRET_LABELS, [CONNECTION_ID_LABEL]: connectionIdLabel(rec.name) },
        annotations: { [ANN_NAME]: rec.name, [ANN_KEY]: rec.key },
      },
      type: 'Opaque',
      // Ciphertext only: the value was sealed (AES-256-GCM) before it reached this function.
      data: { sealed: Buffer.from(rec.sealed, 'utf8').toString('base64') },
    };
  }

  const versionOf = (body: Record<string, unknown>) => String(((body.metadata ?? {}) as { resourceVersion?: string }).resourceVersion ?? '');

  return {
    kind: 'kubernetes',
    async list() {
      const out: SealedRecord[] = [];
      let cont = '';
      for (let page = 0; page < 1000; page++) {
        const q = `?labelSelector=${encodeURIComponent(selector)}&limit=500${cont ? `&continue=${encodeURIComponent(cont)}` : ''}`;
        const res = await k8s('GET', base + q);
        if (!ok(res.status)) throw fail('list', res.status, res.body);
        for (const it of (res.body.items as K8sObj[] | undefined) ?? []) {
          const r = toRecord(it);
          if (r) out.push(r);
        }
        cont = String(((res.body.metadata ?? {}) as { continue?: string }).continue ?? '');
        if (!cont) return out;
      }
      throw new SecretBackendError(0, 'connection-secret store: list did not terminate');
    },
    async read(ref) {
      const res = await k8s('GET', `${base}/${k8sSecretName(ref)}`);
      if (res.status === 404) return null;
      if (!ok(res.status)) throw fail('read', res.status, res.body);
      return toRecord(res.body as K8sObj);
    },
    async write(rec, expected) {
      const name = k8sSecretName(rec);
      if (expected === null) {
        const res = await k8s('POST', base, manifest(rec));
        if (res.status === 409) throw new SecretConflictError(`${name} already exists`);
        if (!ok(res.status)) throw fail('create', res.status, res.body);
        return { version: versionOf(res.body) };
      }
      // Optimistic concurrency: the API server rejects the PUT with 409 if resourceVersion moved on.
      const res = await k8s('PUT', `${base}/${name}`, manifest(rec, expected));
      if (res.status === 409 || res.status === 404) throw new SecretConflictError(`${name} changed since version ${expected}`);
      if (!ok(res.status)) throw fail('update', res.status, res.body);
      return { version: versionOf(res.body) };
    },
    async remove(ref) {
      const res = await k8s('DELETE', `${base}/${k8sSecretName(ref)}`);
      if (!ok(res.status) && res.status !== 404) throw fail('delete', res.status, res.body);
    },
  };
}
