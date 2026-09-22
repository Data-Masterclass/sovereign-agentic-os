/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shortSha,
  imageRepoFor,
  imageTagFor,
  buildJobName,
  dockerConfigJson,
  gitContextRef,
  buildKanikoJob,
  buildServiceEnabled,
  BUILD_SERVICE_OFF_NOTE,
  submitBuildJob,
  jobPhase,
  parseDigest,
  digestRef,
  readBuildJob,
  podPendingReason,
  type K8sClient,
  type BuildRuntime,
} from './build-service.ts';

const RT: BuildRuntime = {
  namespace: 'agentic-apps',
  kanikoImage: 'gcr.io/kaniko-project/executor:v1.23.2',
  registryHost: 'forgejo-http:3000',
  registryOwner: 'gitea_admin',
  gitHost: 'forgejo-http:3000',
  authUser: 'gitea_admin',
  authPassword: 's3cret-admin',
  osApiUrl: 'https://agentic.datamasterclass.com',
};

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// --------------------------------------------------------------------- naming ---

test('shortSha lowercases + strips to 12 hex chars', () => {
  assert.equal(shortSha(SHA), 'a1b2c3d4e5f6');
  assert.equal(shortSha('  A1B2C3D4E5F6XYZ  '), 'a1b2c3d4e5f6');
  assert.equal(shortSha(''), '');
});

test('image repo/tag refs follow <host>/<owner>/<slug>[:sha12]', () => {
  assert.equal(imageRepoFor(RT, 'shop'), 'forgejo-http:3000/gitea_admin/shop');
  assert.equal(imageTagFor(RT, 'shop', SHA), 'forgejo-http:3000/gitea_admin/shop:a1b2c3d4e5f6');
});

test('buildJobName is DNS-1123-safe, unique per (slug, sha), and bounded', () => {
  const n = buildJobName('My Shop!!', SHA);
  assert.equal(n, 'build-my-shop-a1b2c3d4e5f6');
  assert.match(n, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  assert.ok(buildJobName('x'.repeat(80), SHA).length <= 52);
});

// ------------------------------------------------------ context + auth builders ---

test('gitContextRef pins the git tree at the SHA and carries NO creds inline', () => {
  const ref = gitContextRef(RT, 'shop', SHA);
  assert.equal(ref, `git://forgejo-http:3000/gitea_admin/shop.git#${SHA}`);
  assert.ok(!ref.includes(RT.authPassword), 'password must never be embedded in the context URL');
});

test('dockerConfigJson scopes the basic-auth to the registry host only', () => {
  const cfg = JSON.parse(dockerConfigJson(RT)) as { auths: Record<string, { auth: string }> };
  const hosts = Object.keys(cfg.auths);
  assert.deepEqual(hosts, ['forgejo-http:3000']);
  const decoded = Buffer.from(cfg.auths['forgejo-http:3000'].auth, 'base64').toString('utf8');
  assert.equal(decoded, 'gitea_admin:s3cret-admin');
});

// ----------------------------------------------------------- the Job manifest ---

test('buildKanikoJob constructs a daemonless kaniko batch/v1 Job pinned to the digest-file', () => {
  const job = buildKanikoJob('shop', SHA, RT, buildJobName('shop', SHA)) as any;
  assert.equal(job.apiVersion, 'batch/v1');
  assert.equal(job.kind, 'Job');
  assert.equal(job.metadata.namespace, 'agentic-apps');
  assert.equal(job.metadata.labels['sovereign-os/app'], 'shop');
  assert.equal(job.metadata.labels['app.kubernetes.io/managed-by'], 'os-ui');
  // No retries (a build failure must surface, not silently re-run), reaped after finish.
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.ttlSecondsAfterFinished, 3600);
  const pod = job.spec.template.spec;
  assert.equal(pod.restartPolicy, 'Never');
  // The single kaniko container carries the right args.
  const kaniko = pod.containers.find((c: any) => c.name === 'kaniko');
  assert.ok(kaniko, 'a kaniko build container exists');
  assert.equal(kaniko.image, RT.kanikoImage);
  const args: string[] = kaniko.args;
  assert.ok(args.includes(`--context=git://forgejo-http:3000/gitea_admin/shop.git#${SHA}`));
  assert.ok(args.includes('--dockerfile=Dockerfile'));
  assert.ok(args.includes('--destination=forgejo-http:3000/gitea_admin/shop:a1b2c3d4e5f6'));
  assert.ok(args.includes('--digest-file=/dev/termination-log'), 'digest captured via termination message');
  assert.ok(args.includes('--build-arg=OS_API_URL=https://agentic.datamasterclass.com'));
  assert.ok(args.includes('--insecure') && args.includes('--skip-tls-verify'), 'plain-HTTP in-cluster registry');
  // Git creds ride via env (not the URL); DOCKER_CONFIG points at the shared dir.
  const env = Object.fromEntries((kaniko.env as { name: string; value: string }[]).map((e) => [e.name, e.value]));
  assert.equal(env.GIT_USERNAME, 'gitea_admin');
  assert.equal(env.GIT_PASSWORD, 's3cret-admin');
  assert.equal(env.DOCKER_CONFIG, '/kaniko/.docker');
});

test('buildKanikoJob writes the registry auth via an init container into a shared emptyDir', () => {
  const job = buildKanikoJob('shop', SHA, RT, 'build-shop-x') as any;
  const pod = job.spec.template.spec;
  const init = pod.initContainers.find((c: any) => c.name === 'docker-config');
  assert.ok(init, 'an init container writes the docker config');
  // The auth (base64 of user:pass) is written into the shared /kaniko/.docker dir.
  const auth = Buffer.from('gitea_admin:s3cret-admin').toString('base64');
  assert.ok(String(init.args[0]).includes(auth));
  assert.ok(String(init.args[0]).includes('/kaniko/.docker/config.json'));
  // The emptyDir volume is shared by the init writer + the kaniko reader.
  const vol = pod.volumes.find((v: any) => v.name === 'docker-config');
  assert.ok(vol && vol.emptyDir, 'a shared emptyDir carries the config (no in-cluster Secret needed)');
});

// ---------------------------------------------------- feature flag + off note ---

test('buildServiceEnabled requires BOTH the flag and a configured registry', () => {
  assert.equal(buildServiceEnabled({ softwareBuildEnabled: true, harborRegistry: 'r/o' }), true);
  assert.equal(buildServiceEnabled({ softwareBuildEnabled: false, harborRegistry: 'r/o' }), false);
  assert.equal(buildServiceEnabled({ softwareBuildEnabled: true, harborRegistry: '' }), false);
});

test('BUILD_SERVICE_OFF_NOTE is honest about WHY it is off and the Actions fallback', () => {
  assert.match(BUILD_SERVICE_OFF_NOTE, /OFF/);
  assert.match(BUILD_SERVICE_OFF_NOTE, /Forgejo Actions/);
});

// ------------------------------------------------------------- submit honesty ---

test('submitBuildJob POSTs the Job and returns an ok handle', async () => {
  const calls: { method: string; path: string }[] = [];
  const fake: K8sClient = async (method, path) => {
    calls.push({ method, path });
    return { status: 201, body: {} };
  };
  const res = await submitBuildJob('shop', SHA, RT, fake);
  assert.equal(res.ok, true);
  assert.equal(res.reachable, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/apis/batch/v1/namespaces/agentic-apps/jobs');
  assert.equal(res.run.imageTag, 'forgejo-http:3000/gitea_admin/shop:a1b2c3d4e5f6');
});

test('submitBuildJob treats a 409 (build already in flight) as ok, not an error', async () => {
  const fake: K8sClient = async () => ({ status: 409, body: {} });
  const res = await submitBuildJob('shop', SHA, RT, fake);
  assert.equal(res.ok, true);
  assert.match(res.detail, /already in flight/);
});

test('submitBuildJob names the RBAC/namespace fallback specifically on 403/404', async () => {
  for (const status of [403, 404]) {
    const fake: K8sClient = async () => ({ status, body: {} });
    const res = await submitBuildJob('shop', SHA, RT, fake);
    assert.equal(res.ok, false);
    assert.equal(res.reachable, true);
    assert.match(res.detail, /RBAC|permission/i);
    assert.match(res.detail, /Forgejo Actions path still builds/);
  }
});

test('submitBuildJob reports an unreachable cluster honestly (status 0)', async () => {
  const fake: K8sClient = async () => ({ status: 0, body: {} });
  const res = await submitBuildJob('shop', SHA, RT, fake);
  assert.equal(res.ok, false);
  assert.equal(res.reachable, false);
  assert.match(res.detail, /unreachable/);
});

test('submitBuildJob refuses to submit without a SHA (no phantom build)', async () => {
  let called = false;
  const fake: K8sClient = async () => { called = true; return { status: 201, body: {} }; };
  const res = await submitBuildJob('shop', '', RT, fake);
  assert.equal(res.ok, false);
  assert.equal(called, false, 'no Job POST for an empty SHA');
});

// --------------------------------------------------------- digest capture ---

test('jobPhase maps k8s Job status onto the coarse build phase', () => {
  assert.equal(jobPhase(undefined), 'unknown');
  assert.equal(jobPhase({ active: 1 }), 'running');
  assert.equal(jobPhase({ succeeded: 1 }), 'succeeded');
  assert.equal(jobPhase({ failed: 1 }), 'failed');
  assert.equal(jobPhase({}), 'pending');
});

test('parseDigest extracts the sha256 digest from kaniko output, else null', () => {
  assert.equal(
    parseDigest('sha256:' + 'a'.repeat(64) + '\n'),
    'sha256:' + 'a'.repeat(64),
  );
  assert.equal(parseDigest('pushed digest sha256:' + 'B'.repeat(64)), 'sha256:' + 'b'.repeat(64));
  assert.equal(parseDigest('no digest here'), null);
  assert.equal(parseDigest(undefined), null);
});

test('digestRef pins to <registry>/<slug>@<digest>', () => {
  assert.equal(
    digestRef(RT, 'shop', 'sha256:' + 'a'.repeat(64)),
    'forgejo-http:3000/gitea_admin/shop@sha256:' + 'a'.repeat(64),
  );
});

test('readBuildJob captures the pushed digest from the pod termination message on success', async () => {
  const digest = 'sha256:' + 'c'.repeat(64);
  const fake: K8sClient = async (method, path) => {
    if (path.includes('/jobs/')) return { status: 200, body: { status: { succeeded: 1 } } };
    if (path.includes('/pods?')) {
      return {
        status: 200,
        body: {
          items: [
            { status: { containerStatuses: [{ name: 'kaniko', state: { terminated: { message: digest } } }] } },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  };
  const s = await readBuildJob('shop', 'build-shop-x', RT, fake);
  assert.equal(s.phase, 'succeeded');
  assert.equal(s.imageDigest, `forgejo-http:3000/gitea_admin/shop@${digest}`);
});

test('readBuildJob honestly flags a success whose digest could not be captured', async () => {
  const fake: K8sClient = async (method, path) => {
    if (path.includes('/jobs/')) return { status: 200, body: { status: { succeeded: 1 } } };
    return { status: 200, body: { items: [] } };
  };
  const s = await readBuildJob('shop', 'build-shop-x', RT, fake);
  assert.equal(s.phase, 'succeeded');
  assert.equal(s.imageDigest, null);
  assert.match(s.reason, /could not be captured/);
});

test('readBuildJob surfaces a pod waiting reason for a pending build', async () => {
  const fake: K8sClient = async (method, path) => {
    if (path.includes('/jobs/')) return { status: 200, body: { status: {} } };
    if (path.includes('/pods?')) {
      return {
        status: 200,
        body: { items: [{ status: { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }] },
      };
    }
    return { status: 404, body: {} };
  };
  const s = await readBuildJob('shop', 'build-shop-x', RT, fake);
  assert.equal(s.phase, 'pending');
  assert.equal(s.reason, 'ImagePullBackOff');
});

test('readBuildJob degrades to unknown when the cluster is unreachable', async () => {
  const fake: K8sClient = async () => ({ status: 0, body: {} });
  const s = await readBuildJob('shop', 'j', RT, fake);
  assert.equal(s.phase, 'unknown');
  assert.equal(s.imageDigest, null);
});

test('podPendingReason returns the first meaningful waiting reason, else empty', async () => {
  const ok: K8sClient = async () => ({
    status: 200,
    body: { items: [{ status: { initContainerStatuses: [{ state: { waiting: { reason: 'CreateContainerError', message: 'boom' } } }] } }] },
  });
  assert.equal(await podPendingReason('j', 'ns', ok), 'CreateContainerError: boom');
  const none: K8sClient = async () => ({ status: 500, body: {} });
  assert.equal(await podPendingReason('j', 'ns', none), '');
});
