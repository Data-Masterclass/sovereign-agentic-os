#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE:    WP-54 migration — a DRY-RUN plan for the app Deployments that exist in the apps namespace
// USER STORY: As an operator I want to see, before anything changes, which live apps run an image from a
//             registry the platform does not own, and what rebuilding each one natively means.
// ARCHITECTURE:
//   - READ-ONLY. It reads Deployments as JSON (from --from-file, or `kubectl get` with an explicit
//     --context) and prints a plan. It has no apply mode and writes nothing to any cluster or repo.
//   - Per app: current image; whether it is `<registry>/<slug>@sha256:` (the WP-54 rule); the native
//     steps (commit k8s/ + workflow, build the Dockerfile, push, pin the digest, request_deploy →
//     decide_deploy). Apps matching --skip (a regex on the slug) are listed as skipped.
//
// Usage: node scripts/apps-migration-plan.mjs --registry <prefix> [--context <ctx>] [--namespace agentic-apps]
//          [--from-file deployments.json] [--skip '^kiekert-']
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []),
);
const ns = args.namespace || 'agentic-apps';
const registry = String(args.registry || '').replace(/\/+$/, '');
const skip = args.skip ? new RegExp(args.skip) : null;
if (!registry) {
  console.error('--registry <platform registry prefix> is required (softwareRunner.imageRegistry).');
  process.exit(2);
}

const raw = args['from-file']
  ? readFileSync(args['from-file'], 'utf8')
  : execFileSync('kubectl', [...(args.context ? ['--context', args.context] : []), '-n', ns, 'get', 'deployments', '-l', 'app.kubernetes.io/component=software-runner', '-o', 'json'], { encoding: 'utf8' });
const items = JSON.parse(raw).items ?? [];

const digestRe = /@sha256:[a-f0-9]{64}$/;
console.log(`# WP-54 app migration plan (DRY RUN — nothing is changed)\n`);
console.log(`Namespace: ${ns} · platform registry: ${registry} · apps found: ${items.length}\n`);
for (const d of items) {
  const name = d.metadata?.name ?? '?';
  const slug = d.metadata?.labels?.['soa.software-app'] ?? name.replace(/^app-/, '');
  const images = (d.spec?.template?.spec?.containers ?? []).map((c) => c.image);
  const replicas = d.spec?.replicas ?? 0;
  const ready = d.status?.readyReplicas ?? 0;
  console.log(`## ${slug}`);
  console.log(`- now: ${images.join(', ')} · replicas ${ready}/${replicas}`);
  if (skip && skip.test(slug)) {
    console.log('- SKIPPED (excluded by --skip)\n');
    continue;
  }
  const target = `${registry}/${slug}`;
  const ok = images.every((i) => i.startsWith(`${target}@`) && digestRe.test(i));
  if (ok) {
    console.log('- already native (platform registry, digest): no action\n');
    continue;
  }
  const why = images.map((i) => (digestRe.test(i) ? `${i}: not the platform registry` : `${i}: mutable tag and not the platform registry`));
  console.log(`- not deployable under WP-54: ${why.join('; ')}`);
  console.log('- plan:');
  console.log(`  1. find the app's source tree (apps/${slug}/ in its domain repo, or the OS read cache) and its owner;`);
  console.log('     no source anywhere → archive the app and delete the Deployment, Service and Ingress instead;');
  console.log(`  2. commit k8s/deployment.yaml, service.yaml, ingress.yaml and .github/workflows/image.yml (the seed generator);`);
  console.log(`  3. docker build apps/${slug} → docker push ${target}:<git sha> → read the digest;`);
  console.log(`  4. commit the digest into k8s/deployment.yaml (image: ${target}@sha256:<digest>);`);
  console.log('  5. request_deploy → a Builder approves with decide_deploy → the runner applies the committed files.\n');
}
