/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - golden-path templates are real projects in git, instantiated per app
 * USER STORY: As a creator, or a coding tool acting for one, I want a new app to start from a real,
 *             working project that already carries the rules, tests, policy and deploy files, so
 *             software is produced by changing code and never by filling in configuration.
 * ARCHITECTURE:
 *   - A template is a plain directory in the OS repository (`templates/<key>/`): it has its own
 *     package.json, tests, Dockerfile, CI definition, rules files (AGENTS.md + CLAUDE.md) and Rego
 *     policy, and it is the SAME tree an external tool reads. It is not code held in TypeScript strings.
 *   - Instantiation = the template tree + the vendored OS SDK (read from core/app-sdk, as the other
 *     scaffolds do) + the `@sovereign-os` scope pin + the committed npm lockfile with the slug written
 *     into its two name fields (never synthesised; regenerate with scripts/regen-golden-path-lock.mjs).
 *   - Deploy files (k8s/*, image workflow) come from native-deploy.ts so the OS's own deploy gate
 *     validates exactly what is committed; only the resource profile differs per template.
 *   - Platform-owned files (Dockerfile, k8s/, workflows, next.config.mjs) are listed in
 *     {@link PLATFORM_OWNED}; a business-user path may not change them.
 *   - TEMPLATE VERSIONS (App Builder W0, spec 2c): `templates/<key>/` is version 1 and FROZEN; version 2 lives in
 *     `templates/<key>-v2/` (`<key>@2`). Every reader takes an optional `version` (default 1, so every v1 caller is
 *     unchanged) and an app is judged by `App.templateVersion` (absent ⇒ 1), never by the newest template. Version 2
 *     is selectable at create only when the App Builder flag is on ({@link selectableTemplateVersions}).
 *     {@link PLATFORM_OWNED_BY_VERSION} is per version (workstream D adds `migrate/` to v2 only).
 *   - Server-only: reads the template directory (fs).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import { vendorSdkForRepo } from '@tabs/software/lib/app-sdk-vendor';
import { withScopePin } from '@tabs/software/lib/scaffold-lock';
import { appDeployFiles, type DeployContext, type AppResources } from '@tabs/software/lib/native-deploy';
import { TEMPLATE_VERSIONS, type TemplateVersion } from '@tabs/software/lib/app-builder-contracts';

export type { TemplateVersion };

export type GoldenPathKey = 'nextjs-web';

export const GOLDEN_PATHS: Record<GoldenPathKey, { label: string; blurb: string; resources: AppResources }> = {
  'nextjs-web': {
    label: 'Next.js web app (golden path)',
    blurb: 'A real Next.js project with rules files, unit tests, policy checks and deploy files. Reads and writes governed data, runs agents and exposes functions to agents through the OS SDK.',
    resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
  },
};

/**
 * Files no author path may change: the platform owns how the app is built, deployed and GATED. The list is
 * enforced (not merely advertised) on every write path - the MCP push, the UI editor, the commit tool
 * (`commitToApp`, `saveAppFile`) and git receive - by {@link platformOwnedViolations}, and the gates
 * themselves never read the author's copy of the gate files (the sandbox overlays the platform's own).
 * `package-lock.json` is deliberately NOT owned: an author adds dependencies, and the dependency scan plus
 * `npm ci` (which refuses a lockfile that disagrees with package.json) cover it. What the lockfile can no longer
 * do is decide a gate: type check, lint and tests run on the platform's own pinned toolchain
 * (`templates/platform-toolchain`, see {@link platformToolchainFiles}), never on the author's `node_modules`.
 */
export const PLATFORM_OWNED = ['Dockerfile', 'next.config.*', 'k8s/', '.github/workflows/', '.tekton/', 'policy/', 'scripts/factory-gates.mjs', 'vendor/', '.npmrc'] as const;

/**
 * The platform-owned paths PER TEMPLATE VERSION. v1 is {@link PLATFORM_OWNED}, frozen. v2 starts as the same list;
 * workstream D (owner of this table after W0) adds `migrate/`. A version's list only ever grows over v1's.
 */
export const PLATFORM_OWNED_BY_VERSION: Record<TemplateVersion, readonly string[]> = {
  1: PLATFORM_OWNED,
  2: [...PLATFORM_OWNED],
};

/** The platform-owned list an app of this version is judged by. */
export const platformOwnedOf = (version: TemplateVersion = 1): readonly string[] => PLATFORM_OWNED_BY_VERSION[version] ?? PLATFORM_OWNED;

/** The subset of the template the sandbox overlays from the platform before it runs anything. */
export const GATE_FILES = ['policy/', 'scripts/factory-gates.mjs'] as const;

/**
 * Next reads its build settings from `next.config.js|mjs|cjs|ts|mts|cts`. A second file beside the platform's
 * (`next.config.ts` next to `next.config.mjs`) or one below the root would change how the app builds, so every
 * such name is owned at ANY depth. Re-sending the platform's own file unchanged stays accepted.
 */
const NEXT_CONFIG = /^next\.config\.(js|mjs|cjs|ts|mts|cts)$/;

export const isPlatformOwnedPath = (path: string, version: TemplateVersion = 1): boolean => {
  const p = path.replace(/^\.\//, '');
  if (NEXT_CONFIG.test(p.slice(p.lastIndexOf('/') + 1))) return true;
  return platformOwnedOf(version).some((o) => (o.endsWith('/') ? p.startsWith(o) : p === o));
};

/**
 * What a write would change among the platform-owned files: a path is a violation when it is owned and is
 * new or has different bytes than the tree it lands on. Re-sending an unchanged owned file is accepted, so a
 * full-tree push still works.
 */
export function platformOwnedViolations(prior: ScaffoldFile[], incoming: ScaffoldFile[], version: TemplateVersion = 1): string[] {
  const before = new Map(prior.map((f) => [f.path.replace(/^\.\//, ''), f.content]));
  return incoming
    .filter((f) => isPlatformOwnedPath(f.path, version) && before.get(f.path.replace(/^\.\//, '')) !== f.content)
    .map((f) => f.path);
}

/**
 * The owned files the tree HAD and the tree that results from a write no longer has. Every write door merges
 * a changeset over the prior tree and has no delete verb today; this is the check a delete (or a whole-tree
 * replace that omits a file) would hit, so removing the Dockerfile is refused like editing it.
 */
export function platformOwnedRemovals(prior: ScaffoldFile[], after: ScaffoldFile[], version: TemplateVersion = 1): string[] {
  const kept = new Set(after.map((f) => f.path.replace(/^\.\//, '')));
  return prior.map((f) => f.path.replace(/^\.\//, '')).filter((p) => isPlatformOwnedPath(p, version) && !kept.has(p));
}

/**
 * Throws 403 when `incoming` changes a platform-owned file of a golden-path app, or (when `after`, the
 * resulting tree, is given) when the write would leave the tree without an owned file it had.
 */
export function assertNoPlatformOwnedChange(prior: ScaffoldFile[], incoming: ScaffoldFile[], after?: ScaffoldFile[], version: TemplateVersion = 1): void {
  const bad = [...platformOwnedViolations(prior, incoming, version), ...(after ? platformOwnedRemovals(prior, after, version) : [])];
  if (bad.length === 0) return;
  const err = new Error(
    `platform-owned file${bad.length === 1 ? '' : 's'} cannot be changed here: ${bad.slice(0, 5).join(', ')}. ` +
      `The platform owns how the app is built, deployed and gated (${platformOwnedOf(version).join(', ')}). Nothing was written.`,
  ) as Error & { status?: number };
  err.status = 403;
  throw err;
}

/** Where the platform's pinned gate toolchain lives (a sibling of the templates, never copied into an app). */
const TOOLCHAIN_FILES = ['package.json', 'package-lock.json', 'eslint.config.mjs', 'next-allowlist.json'] as const;

/** The platform-pinned toolchain the sandbox installs (`npm ci`) and runs by absolute path. */
export function platformToolchainFiles(): ScaffoldFile[] {
  const dir = join(templatesDir(), 'platform-toolchain');
  return TOOLCHAIN_FILES.map((name) => ({ path: name, content: readFileSync(join(dir, name), 'utf8') }));
}

/** The platform's own copy of the gate files (policy + gates script) for a template. */
export function gateFilesOf(key: GoldenPathKey, version: TemplateVersion = 1): ScaffoldFile[] {
  return readTemplate(key, version).filter((f) => GATE_FILES.some((g) => (g.endsWith('/') ? f.path.startsWith(g) : f.path === g)));
}

/** `files` with every gate file replaced by the platform's copy (the author's versions are dropped). */
export function applyGateOverlay(files: ScaffoldFile[], key: GoldenPathKey, version: TemplateVersion = 1): ScaffoldFile[] {
  const isGate = (p: string) => GATE_FILES.some((g) => (g.endsWith('/') ? p.startsWith(g) : p === g));
  return [...files.filter((f) => !isGate(f.path.replace(/^\.\//, ''))), ...gateFilesOf(key, version)];
}

export const isGoldenPath = (k: unknown): k is GoldenPathKey => typeof k === 'string' && Object.prototype.hasOwnProperty.call(GOLDEN_PATHS, k);

/** The versions each golden path ships. v1 is every template's frozen original. */
export const GOLDEN_PATH_VERSIONS: Record<GoldenPathKey, readonly TemplateVersion[]> = { 'nextjs-web': TEMPLATE_VERSIONS };

/** `templates/<key>/` for v1, `templates/<key>-v2/` for v2. */
export function templateDirOf(key: GoldenPathKey, version: TemplateVersion = 1): string {
  return version === 1 ? key : `${key}-v${version}`;
}

/** `nextjs-web` for v1, `nextjs-web@2` for v2: the form `create_software` and `get_app_template` accept. */
export function templateRef(key: GoldenPathKey, version: TemplateVersion = 1): string {
  return version === 1 ? key : `${key}@${version}`;
}

/** `nextjs-web` → v1, `nextjs-web@1` → v1, `nextjs-web@2` → v2; anything else (unknown key or version) → null. */
export function parseTemplateRef(ref: string): { key: GoldenPathKey; version: TemplateVersion } | null {
  const m = /^([a-z0-9-]+)(?:@(\d+))?$/.exec(ref.trim());
  if (!m || !isGoldenPath(m[1])) return null;
  const version = Number(m[2] ?? '1');
  return (GOLDEN_PATH_VERSIONS[m[1]] as readonly number[]).includes(version) ? { key: m[1], version: version as TemplateVersion } : null;
}

/** The versions a NEW app may be created from: v1 always; later versions only with the App Builder flag on. */
export function selectableTemplateVersions(key: GoldenPathKey, appBuilderOn: boolean): TemplateVersion[] {
  return GOLDEN_PATH_VERSIONS[key].filter((v) => v === 1 || appBuilderOn);
}

const LOCK_PLACEHOLDER = 'sovereign-os-scaffold';
const SKIP = new Set(['node_modules', '.next', '.git']);

/** Where templates live: `$GOLDEN_PATH_TEMPLATES_DIR`, else `<cwd>/templates` (the image), else `<cwd>/../templates` (a checkout). */
export function templatesDir(): string {
  const candidates = [process.env.GOLDEN_PATH_TEMPLATES_DIR, join(process.cwd(), 'templates'), join(process.cwd(), '..', 'templates')].filter((x): x is string => !!x);
  const found = candidates.find((d) => existsSync(d));
  if (!found) throw new Error(`golden-path templates directory not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** The template tree exactly as it is in git (placeholder names untouched). */
export function readTemplate(key: GoldenPathKey, version: TemplateVersion = 1): ScaffoldFile[] {
  const root = join(templatesDir(), templateDirOf(key, version));
  const out: ScaffoldFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ path: relative(root, abs).split('\\').join('/'), content: readFileSync(abs, 'utf8') });
    }
  };
  walk(root);
  return out;
}

export function rulesOf(key: GoldenPathKey, version: TemplateVersion = 1): { agents: string; claude: string; policy: string } {
  const t = readTemplate(key, version);
  const get = (p: string) => t.find((f) => f.path === p)?.content ?? '';
  return { agents: get('AGENTS.md'), claude: get('CLAUDE.md'), policy: get('policy/app-rules.rego') };
}

/** Source tree for a NEW app (no deploy files): template + vendored SDK + scope pin + slug-named lockfile. */
export function goldenPathFiles(key: GoldenPathKey, app: { name: string; slug: string }, version: TemplateVersion = 1): ScaffoldFile[] {
  const files = readTemplate(key, version).map((f) => {
    if (f.path === 'package.json') {
      return { ...f, content: JSON.stringify({ ...JSON.parse(f.content), name: app.slug }, null, 2) + '\n' };
    }
    if (f.path === 'package-lock.json') {
      const lock = JSON.parse(f.content) as { name?: string; packages?: Record<string, { name?: string }> };
      lock.name = app.slug;
      if (lock.packages?.['']) lock.packages[''].name = app.slug;
      return { ...f, content: JSON.stringify(lock, null, 2) + '\n' };
    }
    if (f.path === 'app.yaml') return { ...f, content: f.content.replace(/^name: .*$/m, `name: '${app.name.replace(/'/g, "''")}'`) };
    return f;
  });
  return withScopePin([...files, ...vendorSdkForRepo()]);
}

/** The only configuration a golden-path app reads (AGENTS.md section 8): its slug and where the OS is. */
export function goldenPathEnv(slug: string, osBaseUrl?: string): { name: string; value: string }[] {
  return [{ name: 'APP_SLUG', value: slug }, ...(osBaseUrl ? [{ name: 'OS_BASE_URL', value: osBaseUrl }] : [])];
}

/** The full tree an app is created with: source + the OS's native deploy files with this template's resource profile. */
export function instantiateGoldenPath(
  key: GoldenPathKey,
  app: { name: string; slug: string; osBaseUrl?: string } & Omit<DeployContext, 'slug'>,
  version: TemplateVersion = 1,
): ScaffoldFile[] {
  const source = goldenPathFiles(key, app, version);
  const deploy = appDeployFiles({ ...app, resources: GOLDEN_PATHS[key].resources, env: goldenPathEnv(app.slug, app.osBaseUrl) });
  const owned = new Set(deploy.map((f) => f.path));
  return [...source.filter((f) => !owned.has(f.path) && !f.path.startsWith('k8s/')), ...deploy];
}

export { LOCK_PLACEHOLDER };
