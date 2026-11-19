/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    Locked seeds — a new app is scaffolded WITH a real npm lockfile
 * USER STORY: As a Builder approving the deploy of a freshly generated app I want the dependency
 *             scan to actually cover it, instead of every generated app arriving as
 *             "scan INCOMPLETE (deps not covered)" and needing an admin's written acknowledgement.
 * ARCHITECTURE:
 *   Trivy resolves npm dependencies from `package-lock.json`, so a seed without one is never
 *   dependency-scanned. This module turns a template's plain scaffold into a LOCKED seed.
 *
 *   A LOCKFILE IS NEVER SYNTHESISED. The files under `scaffolds/locks/` are the verbatim output of
 *   `npm install --package-lock-only` (`scripts/regen-scaffold-locks.mjs`) over exactly the
 *   manifests {@link lockInputs} returns. The ONE thing done to them at seed time is writing the
 *   app's slug into the two `name` fields npm copies from `package.json` — the only part of a
 *   lockfile that does not depend on resolution. `scaffold-lock.test.ts` fails when a manifest and
 *   its committed lockfile drift apart, so a dependency bump without a regenerated lock is caught.
 *
 *   WHY THE VITE SEED CHANGES SHAPE. The plain Vite scaffold declares `@sovereign-os/ui` and
 *   `@sovereign-os/app-sdk` as registry ranges (`^0.1.0`). Neither is published, so npm cannot
 *   resolve that manifest at all (E404) and no real lockfile for it can exist. A locked seed
 *   therefore declares both as `file:` dependencies and carries the vendored source under
 *   `vendor/@sovereign-os/*` — the arrangement `app-sdk-vendor.ts` / `app-ui-vendor.ts` were
 *   written for. The result is a tree `npm ci` can really install.
 *
 *   EXISTING APPS ARE NOT TOUCHED. Only `createApp` calls {@link lockedSeed}. `templateFiles()` —
 *   the fallback tree for an app that has no snapshot — still returns the plain scaffold, so an app
 *   created before this change keeps the tree it was seeded with and stays "deps not covered".
 *
 *   No `server-only` import and only relative `.ts` specifiers at runtime, so the regeneration
 *   script can load this file under plain `node`. It reads the vendored source from disk (`fs`),
 *   which keeps it out of any client bundle on its own.
 */
import type { AppTemplateKey } from '@tabs/software/lib/apps';
import { viteLockedDockerfile, viteLockedPackageJson, type ScaffoldFile } from './scaffolds/vite-os.ts';
import { vendorUiForRepo } from './app-ui-vendor.ts';
import { vendorSdkForRepo } from './app-sdk-vendor.ts';
import viteLock from './scaffolds/locks/vite.package-lock.json' with { type: 'json' };
import apiServiceLock from './scaffolds/locks/api-service.package-lock.json' with { type: 'json' };

/** A group of templates that share one manifest, and therefore one lockfile. */
export type LockFamily = 'vite' | 'api-service';

/** The `name` the committed lockfiles were generated under; replaced by the slug at seed time. */
export const LOCK_PLACEHOLDER_NAME = 'sovereign-os-scaffold';

export const LOCK_PATH = 'package-lock.json';

const FAMILY: Partial<Record<AppTemplateKey, LockFamily>> = {
  'vite-os': 'vite',
  'sovereign-app': 'vite',
  website: 'vite',
  empty: 'vite',
  'api-service': 'api-service',
};

/**
 * Which lockfile a template's seed ships, or null when it ships none. The legacy
 * `nextjs-supabase` template has a manifest but no lockfile on purpose: it is not offered for new
 * apps, and `next` resolves `sharp`'s LGPL-3.0 libvips binaries, which the scaffold licence rule
 * (Apache-2.0 / MIT / BSD / ISC) does not admit. It stays honestly "deps not covered".
 */
export function lockFamilyOf(template: AppTemplateKey): LockFamily | null {
  return FAMILY[template] ?? null;
}

type LockJson = { name?: string; packages?: Record<string, { name?: string }> };

const COMMITTED: Record<LockFamily, unknown> = { vite: viteLock, 'api-service': apiServiceLock };

/** The committed lockfile, parsed, exactly as npm wrote it (placeholder name and all). */
export function committedLock(family: LockFamily): Record<string, unknown> {
  return structuredClone(COMMITTED[family]) as Record<string, unknown>;
}

/**
 * The lockfile a new app is seeded with: the committed resolution, with the app's slug in the two
 * `name` fields. Serialised the way npm serialises (2 spaces, trailing newline), so the committed
 * file round-trips byte for byte (asserted by the drift test).
 */
export function lockfileFor(family: LockFamily, slug: string): ScaffoldFile {
  const lock = committedLock(family) as LockJson;
  lock.name = slug;
  const root = lock.packages?.[''];
  if (root) root.name = slug;
  return { path: LOCK_PATH, content: JSON.stringify(lock, null, 2) + '\n' };
}

/** Rewrite a plain scaffold into the tree a locked seed commits, WITHOUT the lockfile itself. */
function lockedTree(family: LockFamily, files: ScaffoldFile[], slug: string): ScaffoldFile[] {
  if (family === 'api-service') return files;
  const swapped = files.map((f) =>
    f.path === 'package.json' ? viteLockedPackageJson(slug) : f.path === 'Dockerfile' ? viteLockedDockerfile() : f,
  );
  return [...swapped, ...vendorUiForRepo(), ...vendorSdkForRepo()];
}

/**
 * Exactly the files `npm install --package-lock-only` reads to resolve a family's lockfile: the
 * seed's root manifest plus the manifest of every vendored local package. The regeneration script
 * writes these to an empty directory and runs npm there; nothing else influences the result.
 */
export function lockInputs(family: LockFamily, plainScaffold: ScaffoldFile[], slug: string = LOCK_PLACEHOLDER_NAME): ScaffoldFile[] {
  return lockedTree(family, plainScaffold, slug).filter((f) => /(^|\/)package\.json$/.test(f.path));
}

/**
 * The seed a NEW app is created with. A template with a lock family gets its real lockfile (and,
 * for the Vite family, the vendored OS packages its manifest now points at); any other template
 * is returned unchanged.
 */
export function lockedSeed(template: AppTemplateKey, files: ScaffoldFile[], slug: string): ScaffoldFile[] {
  const family = lockFamilyOf(template);
  if (!family) return files;
  return [...lockedTree(family, files, slug), lockfileFor(family, slug)];
}
