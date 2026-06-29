/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Self-host the Monaco editor assets (SOVEREIGNTY / air-gap requirement).
 *
 * `@monaco-editor/react` loads the Monaco `vs/` AMD bundle at runtime. By default
 * `@monaco-editor/loader` points at the jsDelivr CDN — a hard no for an offline /
 * EU-residency / air-gapped deployment. We instead copy the `vs/` assets from the
 * pinned `monaco-editor` npm dependency into `public/monaco/vs`, and configure the
 * loader to a SAME-ORIGIN path (`/monaco/vs`) in components/CodePanel.tsx. No
 * external network fetch is ever made for the editor.
 *
 * Runs as `prebuild` (and is safe to run anytime). Idempotent: it clears and
 * recopies the destination. The generated `public/monaco` is gitignored — it is
 * deterministically regenerated from node_modules at build time.
 */
import { cp, rm, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const destDir = join(root, 'public', 'monaco');
const dest = join(destDir, 'vs');

try {
  await access(src);
} catch {
  console.error(
    `[copy-monaco] monaco-editor assets not found at ${src}.\n` +
      `Run \`npm install\` first (monaco-editor is a dependency).`,
  );
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-monaco] self-hosted Monaco vs/ assets -> public/monaco/vs (offline; no CDN).`);
