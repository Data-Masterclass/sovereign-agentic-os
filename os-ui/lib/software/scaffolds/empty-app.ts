/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The EMPTY APP template — the bare minimum that still builds, previews and
 * deploys: the shared Vite infra base + one entry + one page saying the app's
 * name + a README. A blank canvas for people who want no opinions at all.
 *
 * PURE DATA (`{path,content}[]`) like every scaffold module.
 */
import { viteBaseFiles, type ScaffoldFile } from './vite-os.ts';

export type { ScaffoldFile };

/** All files the Empty App template seeds into a new app repo. */
export function emptyAppFiles(name: string, slug: string): ScaffoldFile[] {
  return [
    ...viteBaseFiles(name, slug),
    srcMainTsx(),
    srcAppTsx(name),
    appYaml(name),
    readmeMd(name, slug),
  ];
}

// ----------------------------------------------------------------- src/main.tsx --

function srcMainTsx(): ScaffoldFile {
  return {
    path: 'src/main.tsx',
    content: [
      "import { StrictMode } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import './index.css';",
      "import App from './App.tsx';",
      '',
      "createRoot(document.getElementById('root')!).render(",
      '  <StrictMode>',
      '    <App />',
      '  </StrictMode>,',
      ');',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------ src/App.tsx --

function srcAppTsx(name: string): ScaffoldFile {
  return {
    path: 'src/App.tsx',
    content: [
      '// A blank canvas: replace this with your app.',
      'export default function App() {',
      '  return (',
      "    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '4rem auto', padding: '0 1.5rem' }}>",
      `      <h1>${name}</h1>`,
      '      <p>An empty app — build from here.</p>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------------------------- app.yaml --

function appYaml(name: string): ScaffoldFile {
  return {
    path: 'app.yaml',
    content: [
      'apiVersion: software.sovereign-os/v1',
      'kind: App',
      `name: '${name}'`,
      'owner: gitea_admin',
      `description: '${name} — an empty app built in the Software tab.'`,
      'surface: ui',
      'declares:',
      '  connections: []',
      '  data: []',
      '  knowledge: []',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------------- README --

/** The blank-canvas contract — also injected as the app's docs. */
export function emptyAppGuide(name: string): string {
  return [
    `# ${name}`,
    '',
    'An EMPTY app: the minimum that builds, previews and deploys — a Vite + React',
    'entry (`src/main.tsx` → `src/App.tsx`) served by nginx on port 8080 through the',
    'sovereign CI workflow. No structure is imposed; build whatever the epics say.',
    '',
    'The OS theme tokens (`@sovereign-os/ui/theme.css`) are imported in `src/index.css`',
    'and available if you want the OS look; remove the import if you don’t.',
  ].join('\n');
}

function readmeMd(name: string, _slug: string): ScaffoldFile {
  return { path: 'README.md', content: emptyAppGuide(name) + '\n' };
}

/** The canonical file paths produced by this template (for test assertions). */
export const EMPTY_APP_EXPECTED_PATHS = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
  'tailwind.config.js',
  'postcss.config.js',
  'src/index.css',
  'Dockerfile',
  'nginx.conf',
  '.forgejo/workflows/ci.yml',
  'openapi.yaml',
  'src/main.tsx',
  'src/App.tsx',
  'app.yaml',
  'README.md',
];
