/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - release records: which sha and digest runs in Dev, in each preview slot and in Prod
 * USER STORY: As an app builder I want every rollout to be a release with its sha, image digest, author, migrations and
 *             state, kept in git next to the code, so I always know what runs where and can roll back to the one before.
 * ARCHITECTURE: (spec 6.3)
 *   - Records live on `App.releases` (W0 field, persisted through `persistApp`) and are COMMITTED to the domain repo at
 *     `os/releases/apps/<slug>.yml`, outside `apps/<slug>/` so a release never triggers a build. `os/releases/` is
 *     reserved (the dbt whole-tree generator keeps it) when this module loads with the switch on; it loads at boot
 *     through the lifecycle adapter → consequences.ts.
 *   - The file is the WHOLE `os/releases/apps/` subtree re-written with this app's file replaced (`commitSubtree` has
 *     no single-file write): read at HEAD and committed under one per-domain lock in this process (os-ui runs one
 *     replica while the App Builder is on); a read that would be truncated refuses rather than drop another app's file.
 *   - State machine (pure, tested): deploying → running | failed; running → rolled-back. Nothing else.
 *   - Retention: the newest RELEASE_KEEP per env and slot are kept; the env's current and previous release always.
 *   - `releaseTag(env, id)` = `release-<env>-<id>`, the Zot tag the platform keeps forever (C1 retention).
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { config } from '@core/kernel/config';
import { APPS_DIR, osPath } from '@core/infra/repo-layout';
import type { AppEnv, AppRelease, PreviewSlot } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';

export const RELEASES_DIR = osPath('releases');
export const RELEASES_PREFIX = osPath('releases', APPS_DIR);
export const RELEASE_KEEP = 20;

/** Reserve the subtree as soon as the switch is on (idempotent; a whole-tree commit then keeps it). */
async function reserve(): Promise<void> {
  if (!appBuilderEnabled() || !config.dataProjectGit) return;
  const { reserveSubtree } = await import('@core/infra/git-store');
  reserveSubtree(RELEASES_DIR);
}
void reserve().catch((e) => console.error(`[os-ui] releases: could not reserve os/releases/ — ${e instanceof Error ? e.message : String(e)}`));

export type ReleaseState = AppRelease['state'];
const NEXT: Record<ReleaseState, readonly ReleaseState[]> = {
  deploying: ['running', 'failed'],
  running: ['rolled-back'],
  failed: [],
  'rolled-back': [],
};

/** Pure: may a release go from `from` to `to`? */
export function canTransition(from: ReleaseState, to: ReleaseState): boolean {
  return NEXT[from].includes(to);
}

/** Pure: the record with its new state, or a thrown 409 for an illegal transition. */
export function transition(r: AppRelease, to: ReleaseState): AppRelease {
  if (!canTransition(r.state, to)) throw Object.assign(new Error(`release ${r.id} cannot go from ${r.state} to ${to}`), { status: 409 });
  return { ...r, state: to };
}

/** `r<yyyymmddhhmmss><4 hex>`: sortable, a valid OCI tag fragment and DNS-safe. */
export function newReleaseId(now: Date = new Date(), rand: () => string = () => randomBytes(2).toString('hex')): string {
  return `r${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${rand()}`;
}

/** The registry tag that keeps a release's digest from garbage collection (spec 6.2 retention). */
export const releaseTag = (env: AppEnv, id: string): string => `release-${env}-${id}`;

const byNewest = (x: AppRelease, y: AppRelease) => y.at.localeCompare(x.at) || y.id.localeCompare(x.id);

/** The releases of one env (and slot: undefined = the env itself, not a preview), newest first. */
export function releasesOf(app: Pick<App, 'releases'>, env?: AppEnv, slot?: PreviewSlot | 'any'): AppRelease[] {
  return [...(app.releases ?? [])]
    .filter((r) => (env ? r.env === env : true) && (slot === 'any' ? true : slot ? r.slot === slot : !r.slot))
    .sort(byNewest);
}

/** What serves an env (or slot) now: the newest release that is running. */
export function currentRelease(app: Pick<App, 'releases'>, env: AppEnv, slot?: PreviewSlot): AppRelease | null {
  return releasesOf(app, env, slot).find((r) => r.state === 'running') ?? null;
}

/** The release a rollback of `env` goes to: the running release before the current one, with a different digest. */
export function rollbackTarget(app: Pick<App, 'releases'>, env: AppEnv): AppRelease | null {
  const list = releasesOf(app, env);
  const cur = list.find((r) => r.state === 'running');
  if (!cur) return null;
  return list.find((r) => r !== cur && r.at <= cur.at && r.digest !== cur.digest && (r.state === 'running' || r.state === 'rolled-back')) ?? null;
}

/** Replace or add `r`, then prune: keep RELEASE_KEEP per env+slot, and always the current and previous of each. */
export function withRelease(list: readonly AppRelease[] | undefined, r: AppRelease): AppRelease[] {
  const next = [r, ...(list ?? []).filter((x) => x.id !== r.id)];
  const keep = new Set<string>();
  const groups = new Map<string, AppRelease[]>();
  for (const x of next) {
    const k = `${x.env}/${x.slot ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  for (const g of groups.values()) {
    g.sort(byNewest);
    g.slice(0, RELEASE_KEEP).forEach((x) => keep.add(x.id));
    const running = g.filter((x) => x.state === 'running').slice(0, 2);
    running.forEach((x) => keep.add(x.id));
    if (running[0]?.previous) keep.add(running[0].previous);
  }
  return next.filter((x) => keep.has(x.id)).sort(byNewest);
}

/** The committed release file of one app (records only; never a credential). */
export function releaseFileContent(app: Pick<App, 'id' | 'slug' | 'domain' | 'releases'>): string {
  const doc = {
    app: { id: app.id, slug: app.slug, domain: app.domain },
    releases: releasesOf(app, undefined, 'any').map((r) => ({
      id: r.id, env: r.env, ...(r.slot ? { slot: r.slot } : {}), sha: r.sha, digest: r.digest, at: r.at, by: r.by,
      previous: r.previous, state: r.state, migrations: r.migrations,
    })),
  };
  return `# Release records of app '${app.slug}' (written by the OS; what runs is the manifests at sha + this digest).\n${yaml.dump(doc, { lineWidth: 120, noRefs: true })}`;
}

export const releaseFilePath = (slug: string): string => `${RELEASES_PREFIX}/${slug}.yml`;

export type ReleaseFileOutcome = { ok: true; recorded: boolean; sha?: string; reason?: string } | { ok: false; reason: string };

export type ReleaseStoreDeps = {
  persist?: (app: App) => Promise<unknown>;
  /** Commit the release file; default writes the domain repository. */
  commitFile?: (app: App, actor: { id: string; name?: string }, content: string) => Promise<ReleaseFileOutcome>;
};

const locks = new Map<string, Promise<unknown>>();
function withDomainLock<T>(domain: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(domain) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // The chain keeps the order only; each caller receives its own outcome from `run`.
  locks.set(domain, Promise.allSettled([run]));
  return run;
}

/** Default writer: re-write `os/releases/apps/` with this app's file replaced, as the actor. */
export async function commitReleaseFile(app: App, actor: { id: string; name?: string }, content: string): Promise<ReleaseFileOutcome> {
  const { appProjectGitEnabled } = await import('@tabs/software/lib/git-commit');
  if (!appProjectGitEnabled()) return { ok: true, recorded: false, reason: 'the domain git repository is disabled' };
  if (!app.domain) return { ok: true, recorded: false, reason: 'the app has no domain repository' };
  await reserve();
  const git = await import('@core/infra/git-store');
  return withDomainLock(app.domain, async () => {
    try {
      const files = new Map<string, string>();
      if (git.repoExists(app.domain, { reposDir: config.reposDir })) {
        const head = await git.mainSha(app.domain, { reposDir: config.reposDir });
        if (head) {
          const cur = await git.readFilesAt(app.domain, head, [`${RELEASES_PREFIX}/`], { reposDir: config.reposDir });
          if (cur.truncated) return { ok: false, reason: `${RELEASES_PREFIX}/ is larger than one bounded read; the release file was not written` };
          for (const f of cur.files) files.set(f.path, f.content);
        }
      }
      files.set(releaseFilePath(app.slug), content);
      const { author } = git.authorFor(actor);
      const res = await git.commitSubtree(app.domain, RELEASES_PREFIX, files, {
        author,
        message: `release: ${app.slug} (${app.domain})`,
        trailers: { 'OS-Actor': actor.id, 'OS-Object': `app:${app.id}`, 'OS-Action': 'release' },
        reposDir: config.reposDir,
      });
      return { ok: true, recorded: true, sha: res.sha };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  });
}

async function livePersist(app: App): Promise<unknown> {
  return (await import('@tabs/software/lib/apps')).persistApp(app);
}

/** Store `r` on the app (persisted) and commit the release file. A git failure is returned, never thrown. */
export async function saveRelease(app: App, r: AppRelease, actor: { id: string; name?: string }, deps: ReleaseStoreDeps = {}): Promise<ReleaseFileOutcome> {
  app.releases = withRelease(app.releases, r);
  await (deps.persist ?? livePersist)(app);
  const out = await (deps.commitFile ?? commitReleaseFile)(app, actor, releaseFileContent(app));
  if (!out.ok) console.error(`[os-ui] releases: ${app.domain}/${app.slug} release ${r.id} is stored, but its file was not committed — ${out.reason}`);
  return out;
}
