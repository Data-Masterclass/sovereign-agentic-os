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

/** Files a business-user path may not change: the platform owns how the app is built, deployed and gated. */
export const PLATFORM_OWNED = ['Dockerfile', 'next.config.mjs', 'k8s/', '.github/workflows/', 'policy/', 'scripts/factory-gates.mjs', 'vendor/', '.npmrc', 'package-lock.json'] as const;

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

/** The golden-path key an app's committed tree declares in `app.yaml` (`template: <key>`), or null. */
export function goldenPathKeyOf(files: ScaffoldFile[]): GoldenPathKey | null {
  const m = /^template:\s*['"]?([a-z0-9-]+)['"]?\s*$/m.exec(files.find((f) => f.path === 'app.yaml')?.content ?? '');
  return m && isGoldenPath(m[1]) ? m[1] : null;
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
