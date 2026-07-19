/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Vendoring of the OS UI package (`lib/app-ui/*`) into a governed app.
 *
 * Mirrors `app-sdk-vendor.ts`. `@sovereign-os/ui` is Apache-2.0 os-ui source: a
 * framework-agnostic React + CSS design-system package (theme + primitives +
 * AppShell) so a new OS app starts looking like the OS. It is not a published
 * npm package — a fully sovereign, air-gapped build resolves it locally.
 *
 * Consumers copy the SAME on-disk source (no embedded copy that can drift) into
 * an app repo under `vendor/@sovereign-os/ui/` + a `file:` dependency, so the
 * built image resolves `import { AppShell } from '@sovereign-os/ui'` and
 * `import '@sovereign-os/ui/theme.css'` with no external registry.
 *
 * Server-only (`fs`): every caller is a Node API route or the scaffolder.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type UiFile = { path: string; content: string };

/**
 * The UI source files. `theme.css` first (the side-effect stylesheet), then the
 * primitives (leaves before the barrel), then the barrel. `.tsx`/`.ts` are shipped
 * as source — the app's own bundler (Vite) compiles them, same as the SDK.
 */
const UI_SOURCE_FILES = [
  'theme.css',
  'cx.ts',
  'Button.tsx',
  'Card.tsx',
  'Badge.tsx',
  'Input.tsx',
  'Select.tsx',
  'Table.tsx',
  'Section.tsx',
  'AppShell.tsx',
  'index.ts',
  'README.md',
] as const;

/** Absolute path to the on-disk UI source dir (resolved from the os-ui root). */
function uiDir(): string {
  return join(process.cwd(), 'lib', 'app-ui');
}

/**
 * Read the UI source once and return it as `{path, content}` under a caller-chosen
 * `prefix` (where the package's files should live — e.g.
 * `vendor/@sovereign-os/ui`). A `package.json` is added naming the package with
 * `"main": "index.ts"` and a `"./theme.css"` export so both a bare import and the
 * theme-css side-effect import resolve.
 */
export function readUiSource(prefix: string): UiFile[] {
  const base = prefix.replace(/\/+$/, '');
  const files: UiFile[] = UI_SOURCE_FILES.map((name) => ({
    path: `${base}/${name}`,
    content: readFileSync(join(uiDir(), name), 'utf8'),
  }));
  files.push({
    path: `${base}/package.json`,
    content:
      JSON.stringify(
        {
          name: '@sovereign-os/ui',
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          main: 'index.ts',
          types: 'index.ts',
          exports: {
            '.': './index.ts',
            './theme.css': './theme.css',
          },
          peerDependencies: { react: '>=18', 'react-dom': '>=18' },
        },
        null,
        2,
      ) + '\n',
  });
  return files;
}

/**
 * Vendor the UI into a per-app repo file set (used at seed time). Returns the UI
 * files under `vendor/@sovereign-os/ui/`. A scaffold that declares
 * `@sovereign-os/ui` as a dependency can rewrite it to the local `file:` path via
 * `applyUiFileDep` so `npm ci` resolves from the vendored copy with no registry.
 */
export function vendorUiForRepo(): UiFile[] {
  return readUiSource('vendor/@sovereign-os/ui');
}

/**
 * Rewrite a scaffold `package.json` string so the `@sovereign-os/ui` dependency
 * points at the vendored `file:` path (best-effort: if the field is absent or the
 * JSON is unparseable, the input is returned unchanged so seeding never fails on
 * this). Keeps the deployed build fully sovereign.
 */
export function applyUiFileDep(packageJson: string): string {
  try {
    const pkg = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
    if (pkg.dependencies && '@sovereign-os/ui' in pkg.dependencies) {
      pkg.dependencies['@sovereign-os/ui'] = 'file:./vendor/@sovereign-os/ui';
      return JSON.stringify(pkg, null, 2) + '\n';
    }
  } catch {
    /* leave the original untouched — vendoring is best-effort */
  }
  return packageJson;
}
