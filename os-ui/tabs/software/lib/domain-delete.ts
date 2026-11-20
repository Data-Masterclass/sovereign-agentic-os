/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Software tab's part of "delete domain": every app (its Deployment, Service and
 *             Ingress in the apps namespace, its TLS Secret) and its deploy reviews
 * USER STORY: As the admin deleting a domain I want its apps gone from the cluster too, including
 *             the TLS Secret cert-manager leaves behind because nothing owns it.
 * ARCHITECTURE:
 *   - Apps go through `deleteApp` (the lifecycle's own delete: the runner deletes the Ingress,
 *     Service and Deployment, then the registry grant, profile and snapshot), acting as the owner.
 *     cert-manager garbage-collects the Certificate with its Ingress; the TLS Secret has no owner
 *     reference, so it is deleted through the Kubernetes API, and planned BEFORE its app so a
 *     resumed run still knows its name.
 *   - Reviews go through the review store's confirmed mirror delete.
 */
import 'server-only';
import type { DomainDeleteComponent, PlanItem } from '@core/kernel/domain-delete';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { k8s } from '@core/infra/k8s';
import { ensureHydrated, listAllAppsInternal } from '@tabs/software/lib/apps';
import { deleteApp } from '@tabs/software/lib/lifecycle';
import { listReviewCardsForDomain, purgeReviewCardForDomainDelete } from '@tabs/software/lib/review';

const ns = () => config.softwareRunnerNamespace;
const secretPath = (name: string) => `/api/v1/namespaces/${ns()}/secrets/${encodeURIComponent(name)}`;

export function appsComponent(deps: { owner: (id: string) => Promise<CurrentUser> }): DomainDeleteComponent {
  return {
    component: 'os.apps',
    async plan({ domainId }) {
      await ensureHydrated();
      const apps = (await listAllAppsInternal()).filter((a) => a.domain === domainId);
      const remove: PlanItem[] = [];
      for (const a of apps) {
        // App first (Ingress → cert-manager GCs the Certificate), THEN the TLS Secret: deleting the
        // Secret while the Ingress still exists lets cert-manager re-issue it as an orphan.
        remove.push({ component: 'os.apps', kind: 'app', id: a.id, label: `${a.id} ${a.slug} (Deployment, Service, Ingress app-${a.slug})`, owner: a.owner });
        const tls = `${a.slug}.${a.domain}.${config.appsBaseDomain}-tls`;
        remove.push({ component: 'os.apps', kind: 'tls-secret', id: tls, label: `Secret ${ns()}/${tls} (after its Certificate is gone)` });
      }
      for (const c of await listReviewCardsForDomain(domainId)) remove.push({ component: 'os.apps', kind: 'review', id: c.id, label: `review ${c.id} (${c.appId})` });
      return { component: 'os.apps', remove, keep: [] };
    },
    async remove(item) {
      if (item.kind === 'tls-secret') {
        // Wait until cert-manager's Certificate (named after the Secret, owned by the Ingress) is gone.
        const cert = `/apis/cert-manager.io/v1/namespaces/${ns()}/certificates/${encodeURIComponent(item.id)}`;
        for (let i = 0; ; i++) {
          const c = await k8s('GET', cert);
          if (c.status === 404) break;
          if (c.status !== 200) throw new Error(`Kubernetes API ${c.status || 'unreachable'} reading Certificate ${item.id}`);
          if (i >= 24) throw new Error(`Certificate ${item.id} still exists 2 min after its Ingress was deleted; not deleting its Secret`);
          await new Promise((r) => setTimeout(r, 5000));
        }
        const r = await k8s('DELETE', secretPath(item.id));
        if (r.status !== 404 && (r.status < 200 || r.status >= 300)) throw new Error(`Kubernetes API ${r.status || 'unreachable'} deleting Secret ${item.id}`);
        const after = await k8s('GET', secretPath(item.id));
        if (after.status !== 404) throw new Error(`Secret ${item.id} still present after the delete (HTTP ${after.status})`);
        return r.status === 404 ? 'already absent (Certificate gone)' : `DELETE Secret ${ns()}/${item.id} after its Certificate was gone`;
      }
      if (item.kind === 'review') return `os-software-reviews ${await purgeReviewCardForDomainDelete(item.id)}`;
      const exists = (await listAllAppsInternal()).some((a) => a.id === item.id);
      if (!exists) return 'already absent';
      await deleteApp(item.id, await deps.owner(item.owner!));
      return 'deleteApp (Ingress, Service, Deployment, registry, snapshot)';
    },
  };
}
