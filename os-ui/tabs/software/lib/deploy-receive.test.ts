/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-54: a `git push` of `apps/<slug>/k8s/*.yaml` passes the SAME deploy rules as push_app_files —
 * one validator, registered with the receive gate.
 *
 * FEATURE:    WP-54 receive-gate kind for apps/<slug>/k8s/**
 * USER STORY: As a Builder I want a git push of deploy files checked by the same rules as push_app_files
 * ARCHITECTURE: Registers the kind through registerRepoKind and calls its validate/ingest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __clearRepoKinds, registeredRepoKinds } from '@core/infra/git-receive';
import { registerAppDeployReceive } from './deploy-receive.ts';

test('the receive gate knows apps/<slug>/k8s/** and refuses a NetworkPolicy, accepts a Service', async () => {
  __clearRepoKinds();
  registerAppDeployReceive();
  const kind = registeredRepoKinds().find((k) => k.kind === 'app-deploy');
  assert.ok(kind, 'registered');
  assert.equal(kind!.matches('apps/shop/k8s/service.yaml'), true);
  assert.equal(kind!.matches('apps/shop/src/main.tsx'), false);
  const svc = 'apiVersion: v1\nkind: Service\nmetadata:\n  name: app-shop\nspec:\n  ports: [{port: 80}]\n';
  assert.equal(kind!.validate({ path: 'apps/shop/k8s/service.yaml', content: svc }), null);
  const np = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: app-shop\n';
  assert.match(kind!.validate({ path: 'apps/shop/k8s/np.yaml', content: np }) ?? '', /NetworkPolicy/);
  const rep = await kind!.ingest({ domain: 'sales', files: [], pusher: { id: 'u', role: 'builder', domains: ['sales'] }, sha: 'x' });
  assert.equal(rep.created + rep.updated, 0, 'a push never deploys: deploys go through request_deploy / decide_deploy');
  __clearRepoKinds();
});
