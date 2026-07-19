/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Vendoring of the OS-client SDK (`lib/app-sdk/*.ts`) into a governed app.
 *
 * The SDK is Apache-2.0 os-ui source. Two consumers need its SOURCE as plain
 * `{path, content}` files (not a published npm package, so a fully sovereign,
 * air-gapped build resolves it locally):
 *
 *   1. The Sandpack "Instant preview" (browser) — injects these files under
 *      `node_modules/@sovereign-os/app-sdk/` so a bare
 *      `import { createOsClient } from '@sovereign-os/app-sdk'` resolves in-browser.
 *   2. Seed-time vendoring in `scaffoldRepo` — copies the SAME files into the app
 *      repo under `vendor/@sovereign-os/app-sdk/` + a `file:` dependency, so the
 *      built Docker image can resolve the import with no external registry.
 *
 * Both read the ONE source of truth on disk (no duplicated/embedded copy that can
 * drift). Server-only (`fs`): every caller is a Node API route or the scaffolder.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SdkFile = { path: string; content: string };

/** The SDK source files, in dependency order (leaves first). */
const SDK_SOURCE_FILES = ['errors.ts', 'types.ts', 'client.ts', 'index.ts'] as const;

/** Absolute path to the on-disk SDK source dir (resolved from the os-ui root). */
function sdkDir(): string {
  return join(process.cwd(), 'lib', 'app-sdk');
}

/**
 * Read the SDK source once and return it as `{path, content}` under a caller-chosen
 * prefix. `prefix` is where the package's files should live (e.g.
 * `node_modules/@sovereign-os/app-sdk` for Sandpack, or
 * `vendor/@sovereign-os/app-sdk` for a repo). A `package.json` naming the package
 * with `"main": "index.ts"` is added so a bare import resolves to `index.ts`.
 */
export function readSdkSource(prefix: string): SdkFile[] {
  const base = prefix.replace(/\/+$/, '');
  const files: SdkFile[] = SDK_SOURCE_FILES.map((name) => ({
    path: `${base}/${name}`,
    content: readFileSync(join(sdkDir(), name), 'utf8'),
  }));
  files.push({
    path: `${base}/package.json`,
    content:
      JSON.stringify(
        {
          name: '@sovereign-os/app-sdk',
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          main: 'index.ts',
          types: 'index.ts',
          exports: { '.': './index.ts' },
        },
        null,
        2,
      ) + '\n',
  });
  return files;
}

/**
 * Vendor the SDK into a per-app repo file set (used at seed time). Returns the SDK
 * files under `vendor/@sovereign-os/app-sdk/`. The scaffold's `package.json`
 * already declares `@sovereign-os/app-sdk` as a dependency; `applySdkFileDep`
 * rewrites that to the local `file:` path so `npm ci` in the Docker build resolves
 * it from the vendored copy with no registry access.
 */
export function vendorSdkForRepo(): SdkFile[] {
  return readSdkSource('vendor/@sovereign-os/app-sdk');
}

/**
 * Rewrite a scaffold `package.json` string so the `@sovereign-os/app-sdk`
 * dependency points at the vendored `file:` path (best-effort: if the field is
 * absent or the JSON is unparseable, the input is returned unchanged so seeding
 * never fails on this). Keeps the deployed build fully sovereign.
 */
export function applySdkFileDep(packageJson: string): string {
  try {
    const pkg = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
    if (pkg.dependencies && '@sovereign-os/app-sdk' in pkg.dependencies) {
      pkg.dependencies['@sovereign-os/app-sdk'] = 'file:./vendor/@sovereign-os/app-sdk';
      return JSON.stringify(pkg, null, 2) + '\n';
    }
  } catch {
    /* leave the original untouched — vendoring is best-effort */
  }
  return packageJson;
}
