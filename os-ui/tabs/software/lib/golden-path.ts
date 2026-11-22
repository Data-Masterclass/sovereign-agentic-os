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
 *   - Server-only: reads the template directory (fs).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ScaffoldFile } from '@tabs/software/lib/model';
import { vendorSdkForRepo } from '@tabs/software/lib/app-sdk-vendor';
import { withScopePin } from '@tabs/software/lib/scaffold-lock';
import { appDeployFiles, type DeployContext, type AppResources } from '@tabs/software/lib/native-deploy';

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
 * `npm ci` (which refuses a lockfile that disagrees with package.json) cover it.
 */
export const PLATFORM_OWNED = ['Dockerfile', 'next.config.mjs', 'k8s/', '.github/workflows/', 'policy/', 'scripts/factory-gates.mjs', 'vendor/', '.npmrc'] as const;

/** The subset of the template the sandbox overlays from the platform before it runs anything. */
export const GATE_FILES = ['policy/', 'scripts/factory-gates.mjs'] as const;

export const isPlatformOwnedPath = (path: string): boolean => {
  const p = path.replace(/^\.\//, '');
  return PLATFORM_OWNED.some((o) => (o.endsWith('/') ? p.startsWith(o) : p === o));
};

/**
 * What a write would change among the platform-owned files: a path is a violation when it is owned and is
 * new or has different bytes than the tree it lands on. Re-sending an unchanged owned file is accepted, so a
 * full-tree push still works.
 */
export function platformOwnedViolations(prior: ScaffoldFile[], incoming: ScaffoldFile[]): string[] {
  const before = new Map(prior.map((f) => [f.path.replace(/^\.\//, ''), f.content]));
  return incoming
    .filter((f) => isPlatformOwnedPath(f.path) && before.get(f.path.replace(/^\.\//, '')) !== f.content)
    .map((f) => f.path);
}

/** Throws 403 when `incoming` changes a platform-owned file of a golden-path app. */
export function assertNoPlatformOwnedChange(prior: ScaffoldFile[], incoming: ScaffoldFile[]): void {
  const bad = platformOwnedViolations(prior, incoming);
  if (bad.length === 0) return;
  const err = new Error(
    `platform-owned file${bad.length === 1 ? '' : 's'} cannot be changed here: ${bad.slice(0, 5).join(', ')}. ` +
      `The platform owns how the app is built, deployed and gated (${PLATFORM_OWNED.join(', ')}). Nothing was written.`,
  ) as Error & { status?: number };
  err.status = 403;
  throw err;
}

/** The platform's own copy of the gate files (policy + gates script) for a template. */
export function gateFilesOf(key: GoldenPathKey): ScaffoldFile[] {
  return readTemplate(key).filter((f) => GATE_FILES.some((g) => (g.endsWith('/') ? f.path.startsWith(g) : f.path === g)));
}

/** `files` with every gate file replaced by the platform's copy (the author's versions are dropped). */
export function applyGateOverlay(files: ScaffoldFile[], key: GoldenPathKey): ScaffoldFile[] {
  const isGate = (p: string) => GATE_FILES.some((g) => (g.endsWith('/') ? p.startsWith(g) : p === g));
  return [...files.filter((f) => !isGate(f.path.replace(/^\.\//, ''))), ...gateFilesOf(key)];
}

export const isGoldenPath = (k: unknown): k is GoldenPathKey => typeof k === 'string' && Object.prototype.hasOwnProperty.call(GOLDEN_PATHS, k);

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
export function readTemplate(key: GoldenPathKey): ScaffoldFile[] {
  const root = join(templatesDir(), key);
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

export function rulesOf(key: GoldenPathKey): { agents: string; claude: string; policy: string } {
  const t = readTemplate(key);
  const get = (p: string) => t.find((f) => f.path === p)?.content ?? '';
  return { agents: get('AGENTS.md'), claude: get('CLAUDE.md'), policy: get('policy/app-rules.rego') };
}

/** Source tree for a NEW app (no deploy files): template + vendored SDK + scope pin + slug-named lockfile. */
export function goldenPathFiles(key: GoldenPathKey, app: { name: string; slug: string }): ScaffoldFile[] {
  const files = readTemplate(key).map((f) => {
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
): ScaffoldFile[] {
  const source = goldenPathFiles(key, app);
  const deploy = appDeployFiles({ ...app, resources: GOLDEN_PATHS[key].resources, env: goldenPathEnv(app.slug, app.osBaseUrl) });
  const owned = new Set(deploy.map((f) => f.path));
  return [...source.filter((f) => !owned.has(f.path) && !f.path.startsWith('k8s/')), ...deploy];
}

export { LOCK_PLACEHOLDER };
