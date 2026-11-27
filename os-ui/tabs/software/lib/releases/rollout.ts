/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - roll one release (sha + digest) out to Dev, a preview slot or Prod
 * USER STORY: As an app builder I want every rollout to run my migrations first, apply exactly my committed manifests with
 *             the env's namespace, image digest and host, and stop with the reason when anything fails, while the
 *             previous release keeps serving.
 * ARCHITECTURE: (spec 6.3-6.5, 7, 13)
 *   - THE one door to `apps-dev`/`apps-prod`. Order, each step a typed refusal with zero side effects after it fails:
 *       1. switch on, a v2 app with a domain, a configured app registry (no builder ⇒ `no_builder`, the clear message);
 *       2. the committed `k8s/` at the release sha, validated by native-deploy with the app's domain (names
 *          `appResourceName`, image repository `apps/<domainKey>/<slug>` = the app's OWN domain repository, own Secrets);
 *       3. the digest exists in that repository (Zot, read-only pull identity) — an image of another domain's repository
 *          can never be named: the repository is derived from the app's domain, never taken from input;
 *       4. a `deploying` release record (stored + committed);
 *       5. EVERY pre-deploy hook (D's `app-env`, then `migrations`), with the release image; a refusal fails the release
 *          before anything is applied (the previous release keeps running). Rollbacks and preview slots skip them
 *          (forward-only migrations; a slot runs a sha the Dev rollout already migrated);
 *       6. the closed overlay (overlay.ts) and the runner's dry-run-then-apply (runner.ts `applyEnvObjects`);
 *       7. `running`, audited; the Deployment carries the release id, sha and the release tags it pins.
 *   - The image the pods pull is `<pull host>/apps/<domainKey>/<slug>@<digest>` (the node-facing registry host; the
 *     in-cluster host when no separate pull host exists). Hooks get the same reference (D's Job policy admits both).
 *   - RELEASE TAGS (spec 6.2 retention): `release-<env>-<id>` may be written only by a platform identity (C1's Zot
 *     policy refuses push users); os-ui holds no registry write credential, so the rollout records the tags each env
 *     must keep on its Deployment (`soa.dev/release-tags`, core/adapters/zot `releasePins`) for the platform keeper.
 *   - Everything injectable (`RolloutDeps`) so the whole order is unit-tested without a cluster.
 */
import 'server-only';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { config } from '@core/kernel/config';
import type { Fetched } from '@core/adapters/_contract';
import { digestExists as zotDigestExists, imageRepository, livePullAuth, releasePins, RELEASE_PINS_ANNOTATION } from '@core/adapters/zot/client';
import { record as recordAudit } from '@core/policy/audit';
import { appResourceName, templateVersionOf, type AppEnv, type AppRelease, type PreviewSlot } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { planAppDeploy } from '@tabs/software/lib/native-deploy';
import { runPreDeployHooks, type PreDeployInput, type PreDeployResult } from '@tabs/software/lib/pre-deploy-hooks';
import { applyEnvObjects, type ApplyOutcome, type RunnerK8s, type RunnerTree } from '@tabs/software/lib/runner';
import { appEnvHost, applyEnvOverlay, applyPreviewOverlay } from '@tabs/software/lib/releases/overlay';
import { currentRelease, newReleaseId, releasesOf, saveRelease, transition, type ReleaseStoreDeps } from '@tabs/software/lib/releases/store';

export const NO_BUILDER_REASON =
  'No app builder is configured on this installation, so there is no image to release: builds and releases need a gated ' +
  'builder digest (softwareRunner.environments.build.image, listed in files/builder-digests.txt) and build isolation ' +
  '(build.isolation: dedicated-nodes or sandbox-runtime) - see docs/components/app-builder-build.md. Nothing was deployed.';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export type RolloutReason = 'auto-dev' | 'go-live' | 'rollback' | 'preview' | 'manual';
export type RolloutInput = {
  env: AppEnv;
  sha: string;
  digest: string;
  by: { id: string; name?: string };
  reason: RolloutReason;
  slot?: PreviewSlot;
  /** Rollback (forward-only migrations) and preview slots: no pre-deploy hooks. */
  skipHooks?: boolean;
};
export type RolloutCode = 'disabled' | 'not_v2' | 'no_builder' | 'invalid' | 'no_host' | 'tree' | 'digest' | 'hooks' | 'apply' | 'offline';
export type RolloutResult =
  | { ok: true; release: AppRelease; url: string; applied: string[] }
  | { ok: false; code: RolloutCode; reason: string; release: AppRelease | null };

export type RolloutDeps = ReleaseStoreDeps & {
  k8s?: RunnerK8s;
  /** The app tree at a sha (default: the domain repository). */
  readTree?: (app: App, sha: string) => Promise<RunnerTree>;
  runHooks?: (i: PreDeployInput) => Promise<PreDeployResult>;
  /** Does `apps/<domainKey>/<slug>@digest` exist in the registry? (default: Zot HEAD with the pull identity) */
  digestExists?: (repository: string, digest: string) => Promise<Fetched<boolean>>;
  apply?: (objects: Record<string, unknown>[], namespace: string) => Promise<ApplyOutcome>;
  registry?: string;
  pullRegistry?: string;
  appsDomain?: string;
  ingressClass?: string;
  tlsIssuer?: string;
  namespace?: (env: AppEnv) => string;
  now?: () => Date;
  audit?: (e: Parameters<typeof recordAudit>[0]) => void;
};

export const envNamespaceOf = (env: AppEnv): string => (env === 'prod' ? config.appsProdNamespace : config.appsDevNamespace);

async function liveReadTree(app: App, sha: string): Promise<RunnerTree> {
  const { readAppTreeState } = await import('@tabs/software/lib/git-commit');
  const state = await readAppTreeState(app, { ref: sha });
  if (state.kind !== 'tree') return state;
  if (state.truncated) return { kind: 'failed', reason: 'the app tree is larger than one bounded read; it was not deployed from a partial tree' };
  return { kind: 'tree', files: state.files, sha };
}

const liveDigestExists = (repository: string, digest: string) =>
  zotDigestExists(repository, digest, { fetch, registryHost: config.appRegistry, pullAuth: livePullAuth() });

/** The image every pod of the release pulls: the node-facing host when there is one. */
export function releaseImage(app: Pick<App, 'domain' | 'slug'>, digest: string, registry: string, pull?: string): string {
  return `${(pull || registry).replace(/\/+$/, '')}/${imageRepository(app.domain, app.slug)}@${digest}`;
}

/** The URL a release serves (env host, or the slot host in Dev). */
export function releaseUrl(app: Pick<App, 'domain' | 'slug'>, env: AppEnv, slot?: PreviewSlot, appsDomain: string = config.appsBaseDomain): string | null {
  const h = appEnvHost(app.domain, app.slug, env, appsDomain, slot);
  return h ? `https://${h}` : null;
}

export async function rolloutRelease(app: App, input: RolloutInput, deps: RolloutDeps = {}): Promise<RolloutResult> {
  const refuse = (code: RolloutCode, reason: string, release: AppRelease | null = null): RolloutResult => ({ ok: false, code, reason, release });
  if (!appBuilderEnabled()) return refuse('disabled', 'the App Builder is not enabled');
  if (templateVersionOf(app) !== 2 || !app.domain) return refuse('not_v2', 'only an App Builder app (nextjs-web@2) with a domain is released to Dev and Prod');
  const registry = (deps.registry ?? config.appRegistry).replace(/\/+$/, '');
  const pull = (deps.pullRegistry ?? config.appRegistryPull).replace(/\/+$/, '');
  if (!registry) return refuse('no_builder', NO_BUILDER_REASON);
  if (!SHA_RE.test(input.sha)) return refuse('invalid', `'${input.sha}' is not a full commit sha`);
  if (!DIGEST_RE.test(input.digest)) return refuse('invalid', `'${input.digest}' is not an image digest (sha256:…)`);
  if (input.slot && input.env !== 'dev') return refuse('invalid', 'preview slots exist in Dev only');
  const appsDomain = deps.appsDomain ?? config.appsBaseDomain;
  const host = appEnvHost(app.domain, app.slug, input.env, appsDomain, input.slot);
  const committedHost = appEnvHost(app.domain, app.slug, 'prod', appsDomain);
  if (!host || !committedHost) return refuse('no_host', `the domain id '${app.domain}' is not a DNS label, so this app has no host (rename the domain or move the app)`);

  // 2. The committed manifests at the release sha, judged with the app's domain (names, own image repository, Secrets).
  const tree = await (deps.readTree ?? liveReadTree)(app, input.sha);
  if (tree.kind !== 'tree') return refuse('tree', tree.kind === 'failed' ? `the app's manifests are read from git and git could not be read (${tree.reason})` : `there is no tree for ${app.slug} at ${input.sha.slice(0, 12)}`);
  const plan = planAppDeploy(tree.files, {
    slug: app.slug,
    host: committedHost,
    registry,
    registries: [registry, pull].filter(Boolean),
    ingressClass: deps.ingressClass ?? config.appsIngressClass,
    tlsIssuer: deps.tlsIssuer ?? config.appsTlsIssuer,
    domain: app.domain,
    templateVersion: 2,
  }, { allowUnbuilt: true });
  if (!plan.ok) return refuse('invalid', plan.reason);
  const committed = plan.objects;

  // 3. The digest is in THIS app's repository of THIS domain (never a repository taken from input).
  const repository = imageRepository(app.domain, app.slug);
  const has = await (deps.digestExists ?? liveDigestExists)(repository, input.digest);
  if (!has.ok) return refuse('digest', `the registry could not confirm ${repository}@${input.digest.slice(0, 19)}… (${has.detail}); nothing was deployed`);
  if (!has.value) return refuse('digest', `${input.digest.slice(0, 19)}… is not an image of this app in its own domain repository ${repository}; nothing was deployed`);

  const now = (deps.now ?? (() => new Date()))();
  const namespace = (deps.namespace ?? envNamespaceOf)(input.env);
  const image = releaseImage(app, input.digest, registry, pull);
  const prior = currentRelease(app, input.env, input.slot);
  let release: AppRelease = {
    id: newReleaseId(now),
    slug: app.slug,
    env: input.env,
    ...(input.slot ? { slot: input.slot } : {}),
    sha: input.sha,
    digest: input.digest,
    at: now.toISOString(),
    by: input.by.id,
    previous: prior?.id ?? null,
    migrations: { applied: [], status: 'none' },
    state: 'deploying',
  };
  await saveRelease(app, release, input.by, deps);
  const audit = deps.audit ?? recordAudit;
  const fail = async (code: RolloutCode, reason: string, migrationsFailed = false): Promise<RolloutResult> => {
    release = { ...transition(release, 'failed'), ...(migrationsFailed ? { migrations: { applied: [], status: 'failed' as const } } : {}) };
    await saveRelease(app, release, input.by, deps);
    audit({ actor: input.by.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `release ${release.id} to ${input.env}${input.slot ? `/${input.slot}` : ''} failed: ${reason.slice(0, 300)}`, detail: { kind: 'app.release', outcome: 'failed', step: code, env: input.env, slot: input.slot ?? null, releaseId: release.id, sha: input.sha, digest: input.digest, why: input.reason } });
    return refuse(code, reason, release);
  };

  // 5. Pre-deploy hooks (D: platform env, then migrations) with the release image. A refusal stops the rollout.
  if (!input.skipHooks && !input.slot) {
    const hooks = await (deps.runHooks ?? runPreDeployHooks)({ slug: app.slug, domain: app.domain, env: input.env, namespace, image, sha: input.sha });
    if (!hooks.ok) return fail('hooks', hooks.reason, /^migrations:/.test(hooks.reason));
    release = { ...release, migrations: { applied: hooks.applied, status: hooks.applied.length ? 'ok' : 'none' } };
  }

  // 6. The closed overlay, the release record on the Deployment, dry run then apply.
  const overlaid = input.slot
    ? applyPreviewOverlay(committed, { namespace, image, host, domain: app.domain, slug: app.slug, slot: input.slot })
    : applyEnvOverlay(committed, { namespace, image, host });
  const pins = releasePins([...releasesOf(app, input.env, input.slot), release].filter((r) => r.state !== 'failed'), 10);
  const recorded = overlaid.map((obj) => {
    if (obj.kind !== 'Deployment') return obj;
    const meta = (obj.metadata ?? {}) as Record<string, unknown>;
    const ann = { ...((meta.annotations ?? {}) as Record<string, string>), 'soa.dev/release': release.id, 'soa.dev/release-sha': input.sha, [RELEASE_PINS_ANNOTATION]: JSON.stringify(pins) };
    return { ...obj, metadata: { ...meta, annotations: ann } };
  });
  const applied = await (deps.apply ?? ((o, ns) => applyEnvObjects(o, ns, deps.k8s)))(recorded, namespace);
  if (!applied.ok) return fail(applied.offline ? 'offline' : 'apply', applied.detail);

  release = transition(release, 'running');
  await saveRelease(app, release, input.by, deps);
  audit({ actor: input.by.id, action: 'deploy', subject: app.id, domain: app.domain, reason: `release ${release.id} (${input.sha.slice(0, 12)}) running in ${input.env}${input.slot ? `/${input.slot}` : ''} (${input.reason})`, detail: { kind: 'app.release', outcome: 'running', env: input.env, slot: input.slot ?? null, releaseId: release.id, sha: input.sha, digest: input.digest, previous: release.previous, migrations: release.migrations.applied, why: input.reason, deployment: appResourceName(app.domain, app.slug, input.slot) } });
  return { ok: true, release, url: `https://${host}`, applied: applied.applied };
}
