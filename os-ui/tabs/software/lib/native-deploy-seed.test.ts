/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-54: a NEW coded app is seeded with its native deploy code — k8s/ manifests for its own host
 * and the image CI workflow — next to the template's Dockerfile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp } from '@tabs/software/lib/apps';
import { getSnapshot } from '@tabs/software/lib/snapshot';
import { APP_CI_WORKFLOW, NOT_BUILT_DIGEST } from './native-deploy.ts';

const creator: CurrentUser = { id: 'wp54-alice', name: 'Alice', domains: ['sales'], role: 'creator' };

test('createApp seeds k8s/ manifests for the app\'s own host + the CI workflow, beside the Dockerfile', async () => {
  const app = await createApp(creator, { name: 'Seed Deploy', template: 'website', kind: 'code', domain: 'sales' } as never);
  const files = getSnapshot(app.id) ?? [];
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes('Dockerfile'), 'the template Dockerfile');
  for (const p of ['k8s/deployment.yaml', 'k8s/service.yaml', 'k8s/ingress.yaml', APP_CI_WORKFLOW]) assert.ok(paths.includes(p), p);
  const ing = yaml.load(files.find((f) => f.path === 'k8s/ingress.yaml')!.content) as any;
  assert.equal(ing.spec.rules[0].host, `${app.slug}.${app.domain}.apps.local`);
  const dep = yaml.load(files.find((f) => f.path === 'k8s/deployment.yaml')!.content) as any;
  assert.ok(String(dep.spec.template.spec.containers[0].image).endsWith(`/${app.slug}@${NOT_BUILT_DIGEST}`), 'not built yet');
});

test('a declarative (spec) app gets no deploy files — the OS serves it itself', async () => {
  const app = await createApp(creator, { name: 'Seed Spec', kind: 'spec', domain: 'sales' } as never);
  assert.equal((getSnapshot(app.id) ?? []).some((f) => f.path.startsWith('k8s/')), false);
});
