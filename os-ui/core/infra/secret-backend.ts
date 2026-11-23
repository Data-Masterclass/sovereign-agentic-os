/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where sealed connection credentials are kept — one small interface, two backends
 * USER STORY: As a user I connect a system once and the connection keeps working after the OS
 *             restarts, and agent runs in the worker can use it too; as a maintainer I want to move the
 *             store to STACKIT Secrets Manager later by writing ONE new backend, not by touching ~30 callers.
 * ARCHITECTURE:
 *   - `SecretBackend` stores SEALED values only (`secret-crypto.ts` ciphertext): list / write / remove.
 *     The cache, hydration, write-through and health live in `secrets.ts`; a backend is pure storage.
 *   - `kubernetesSecretBackend`: one Kubernetes Secret per `name/key` ref in the release namespace,
 *     through the in-cluster API (`k8s.ts`, injected so it unit-tests against a fake) with the `os-ui`
 *     ServiceAccount (os-ui and os-ui-worker share it). Labels `app.kubernetes.io/managed-by=os-ui`,
 *     `app.kubernetes.io/component=connection-secret`, `os.connection-id=<ref name>`; the ref itself in
 *     annotations; the ciphertext in `data.sealed`. Create = POST, replace = PUT (whole object, we own
 *     it), 409 on POST → PUT. List is label-selected and paginated (`continue`).
 *   - `memorySecretBackend`: a Map. Local dev and tests only, selected explicitly (`OS_SECRETS_BACKEND`)
 *     or because the process is not in a cluster — never as a fallback for a failing cluster.
 *   - Every failure throws `SecretBackendError` with the API status — never a value.
 */
import { createHash } from 'crypto';

export type SecretRefLike = { name: string; key: string };
/** One stored credential: its ref, the sealed value (ciphertext envelope) and when it was written. */
export type SealedRecord = { name: string; key: string; sealed: string; updatedAt: string };

export interface SecretBackend {
  readonly kind: 'memory' | 'kubernetes';
  /** Every stored record. Throws {@link SecretBackendError} when the store cannot be read. */
  list(): Promise<SealedRecord[]>;
  write(rec: SealedRecord): Promise<void>;
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

// --------------------------------------------------------------------------- memory --

/** In-process store. Pass a shared Map to simulate two processes reading one store (tests). */
export function memorySecretBackend(store: Map<string, SealedRecord> = new Map()): SecretBackend & { store: Map<string, SealedRecord> } {
  const k = (r: SecretRefLike) => `${r.name}/${r.key}`;
  return {
    kind: 'memory',
    store,
    async list() {
      return [...store.values()].map((r) => ({ ...r }));
    },
    async write(rec) {
      store.set(k(rec), { ...rec });
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
const ANN_UPDATED = 'sovereign-os.io/updated-at';
const NAME_PREFIX = 'os-conn-secret-';

function slug(s: string, max: number): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
}

/**
 * The Kubernetes object name for a ref: DNS-1123, <= 63 chars (fits every resource), readable prefix
 * plus a hash of the exact ref, so two refs that slug alike never collide.
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
    : status === 401 || status === 403 ? `the os-ui ServiceAccount is not allowed to ${op} Secrets (RBAC: chart rule os-ui-connection-secrets)`
      : `the Kubernetes API answered ${status}`;
  const msg = typeof body?.message === 'string' ? `: ${String(body.message).slice(0, 200)}` : '';
  return new SecretBackendError(status, `connection-secret store: cannot ${op} — ${why}${msg}`);
}

export function kubernetesSecretBackend(opts: { namespace: string; k8s: K8sCall }): SecretBackend {
  const { namespace: ns, k8s } = opts;
  const base = `/api/v1/namespaces/${encodeURIComponent(ns)}/secrets`;
  const selector = Object.entries(SECRET_LABELS).map(([k, v]) => `${k}=${v}`).join(',');

  function manifest(rec: SealedRecord) {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: k8sSecretName(rec),
        namespace: ns,
        labels: { ...SECRET_LABELS, [CONNECTION_ID_LABEL]: connectionIdLabel(rec.name) },
        annotations: { [ANN_NAME]: rec.name, [ANN_KEY]: rec.key, [ANN_UPDATED]: rec.updatedAt },
      },
      type: 'Opaque',
      // Ciphertext only: the value was sealed (AES-256-GCM) before it reached this function.
      data: { sealed: Buffer.from(rec.sealed, 'utf8').toString('base64') },
    };
  }

  return {
    kind: 'kubernetes',
    async list() {
      const out: SealedRecord[] = [];
      let cont = '';
      for (let page = 0; page < 1000; page++) {
        const q = `?labelSelector=${encodeURIComponent(selector)}&limit=500${cont ? `&continue=${encodeURIComponent(cont)}` : ''}`;
        const res = await k8s('GET', base + q);
        if (!ok(res.status)) throw fail('list', res.status, res.body);
        const items = (res.body.items as Record<string, unknown>[] | undefined) ?? [];
        for (const it of items) {
          const md = (it.metadata ?? {}) as { annotations?: Record<string, string> };
          const ann = md.annotations ?? {};
          const data = (it.data ?? {}) as Record<string, string>;
          if (!ann[ANN_NAME] || !ann[ANN_KEY] || typeof data.sealed !== 'string') continue;
          out.push({ name: ann[ANN_NAME], key: ann[ANN_KEY], updatedAt: ann[ANN_UPDATED] ?? '', sealed: Buffer.from(data.sealed, 'base64').toString('utf8') });
        }
        cont = String(((res.body.metadata ?? {}) as { continue?: string }).continue ?? '');
        if (!cont) return out;
      }
      throw new SecretBackendError(0, 'connection-secret store: list did not terminate');
    },
    async write(rec) {
      const m = manifest(rec);
      const path = `${base}/${m.metadata.name}`;
      let res = await k8s('PUT', path, m);
      if (res.status === 404) {
        res = await k8s('POST', base, m);
        if (res.status === 409) res = await k8s('PUT', path, m); // created concurrently by the other pod
      }
      if (!ok(res.status)) throw fail('write', res.status, res.body);
    },
    async remove(ref) {
      const res = await k8s('DELETE', `${base}/${k8sSecretName(ref)}`);
      if (!ok(res.status) && res.status !== 404) throw fail('delete', res.status, res.body);
    },
  };
}
