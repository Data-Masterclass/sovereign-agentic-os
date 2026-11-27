/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - the closed deploy overlay: what may differ between the committed manifests, Dev and Prod
 * USER STORY: As an engineer I want Dev and Prod to run exactly my committed k8s/ files, with only the namespace, the
 *             image digest and the host changed, so what I test is what goes live and I can eject it with kubectl.
 * ARCHITECTURE: (spec 6.4, 6.5, 2b)
 *   - PURE. `applyEnvOverlay` changes EXACTLY three things on the committed objects: `metadata.namespace` (every
 *     object), the app container image (Deployment, `<registry>/apps/<domainKey>/<slug>@<release digest>`) and the
 *     Ingress host + its `<host>-tls` secret. Nothing else; a test diffs every other field. It is the `kustomize edit set
 *     image` + namespace equivalent the eject docs show.
 *   - `applyPreviewOverlay` = the env overlay plus the slot's names (`appResourceName(domain, slug, 'p1'|'p2')`) on the
 *     Deployment, its pod label/selector, the Service and the Ingress backend, and the slot host. The slot shares the
 *     dev database and env Secret (D's admission policy derives the own Secrets from the workload name minus `-p1/-p2`).
 *   - Hosts (spec 2b): Prod `<label>.<domain>.<appsDomain>`, Dev `<label>.<domain>.dev.<appsDomain>`, slots
 *     `<label>-p1|p2.<domain>.dev.<appsDomain>`; a label over 63 characters is cut and given the 8-hex app hash. This is
 *     the SAME rule as the app-login callback hosts (os-ui/app-token-sources.ts `appCallbackHosts`), pinned by a test,
 *     so every URL an app serves is a registered sign-in callback. A domain id that is not a DNS label has no host.
 */
import { appNameHash, appResourceName, type AppEnv, type PreviewSlot } from '@tabs/software/lib/app-builder-contracts';

type Obj = Record<string, unknown>;

export const isDnsLabelDomain = (domain: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain);

/** One DNS label from a slug (+ optional slot): at most 63 characters, the 8-hex hash when it had to be cut. */
export function appHostLabel(domain: string, slug: string, slot?: PreviewSlot): string {
  const full = slot ? `${slug}-${slot}` : slug;
  if (full.length <= 63) return full;
  const tail = `-${appNameHash(domain, slug)}${slot ? `-${slot}` : ''}`;
  return `${slug.slice(0, 63 - tail.length).replace(/-+$/, '')}${tail}`;
}

/** The host an app serves in `env` (a slot only in dev), or null when the domain id is not a DNS label. */
export function appEnvHost(domain: string, slug: string, env: AppEnv, appsDomain: string, slot?: PreviewSlot): string | null {
  if (!isDnsLabelDomain(domain) || !appsDomain) return null;
  if (slot && env !== 'dev') return null;
  return `${appHostLabel(domain, slug, slot)}.${domain}.${env === 'dev' ? 'dev.' : ''}${appsDomain}`;
}

export type OverlayInput = {
  namespace: string;
  /** The full image reference by digest, `<registry>/apps/<domainKey>/<slug>@sha256:…`. */
  image: string;
  /** The env (or slot) host; the TLS secret is always `<host>-tls` (the apps admission policy's rule). */
  host: string;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const a = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

/**
 * The committed objects with the three env fields set. Every container of the Deployment's pod (the v2 template has one)
 * gets the release image: the deploy gate already refused any image that is not this app's own repository.
 */
export function applyEnvOverlay(objects: readonly Obj[], i: OverlayInput): Obj[] {
  return objects.map((src) => {
    const obj = clone(src);
    obj.metadata = { ...o(obj.metadata), namespace: i.namespace };
    if (obj.kind === 'Deployment') {
      const pod = o(o(o(obj.spec).template).spec);
      for (const c of [...a(pod.containers), ...a(pod.initContainers)]) c.image = i.image;
    }
    if (obj.kind === 'Ingress') {
      const spec = o(obj.spec);
      for (const r of a(spec.rules)) r.host = i.host;
      for (const t of a(spec.tls)) {
        t.hosts = [i.host];
        t.secretName = `${i.host}-tls`;
      }
    }
    return obj;
  });
}

/** The env overlay for a preview slot, plus the slot's own object names (Deployment, pod label, Service, Ingress). */
export function applyPreviewOverlay(objects: readonly Obj[], i: OverlayInput & { domain: string; slug: string; slot: PreviewSlot }): Obj[] {
  const base = appResourceName(i.domain, i.slug);
  const name = appResourceName(i.domain, i.slug, i.slot);
  return applyEnvOverlay(objects, i).map((obj) => {
    const meta = o(obj.metadata);
    meta.name = name;
    const labels = o(meta.labels);
    if (labels['app.kubernetes.io/name'] === base) meta.labels = { ...labels, 'app.kubernetes.io/name': name };
    if (obj.kind === 'Deployment') {
      const spec = o(obj.spec);
      spec.selector = { matchLabels: { 'app.kubernetes.io/name': name } };
      const tpl = o(spec.template);
      const tm = o(tpl.metadata);
      tm.labels = { ...o(tm.labels), 'app.kubernetes.io/name': name };
      tpl.metadata = tm;
    }
    if (obj.kind === 'Service') o(obj.spec).selector = { 'app.kubernetes.io/name': name };
    if (obj.kind === 'Ingress') {
      for (const r of a(o(obj.spec).rules)) {
        for (const p of a(o(r.http).paths)) {
          const svc = o(o(p.backend).service);
          if (svc.name === base) svc.name = name;
        }
      }
    }
    return obj;
  });
}

/**
 * Every path whose value differs between two JSON values (`a.b[0].c`), for the overlay's exactness test and the review
 * card ("what the overlay changed").
 */
export function changedPaths(before: unknown, after: unknown, at = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === 'object';
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) return [at || '.'];
  const keys = new Set([...Object.keys(before as Obj), ...Object.keys(after as Obj)]);
  const out: string[] = [];
  for (const k of keys) {
    const p = Array.isArray(before) ? `${at}[${k}]` : at ? `${at}.${k}` : k;
    out.push(...changedPaths((before as Obj)[k], (after as Obj)[k], p));
  }
  return out;
}
