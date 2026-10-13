/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The WEBSITE template — a PUBLIC-FACING site (landing/marketing style).
 *
 * Like the other scaffolds this module is PURE DATA (`{path,content}[]`) written
 * into the per-app Forgejo repo by the seeder; it is never compiled as live
 * os-ui source.
 *
 * Design contract:
 *   • Vite + React + the SAME `@sovereign-os/ui` THEME TOKENS (imported once in
 *     src/index.css via viteBaseFiles) for visual coherence with the OS — but
 *     NO sign-in, NO admin, NO identity chrome: it is a public site.
 *   • Simple pages: a Home hero + placeholder sections driven by one SECTIONS
 *     registry; epics add pages/sections there (the README documents the contract).
 *   • Same infra base as every governed SPA (`viteBaseFiles`): Vite build,
 *     nginx on 8080, the sovereign CI workflow — preview/CI/deploy identical.
 */
import { viteBaseFiles, type ScaffoldFile } from './vite-os.ts';

export type { ScaffoldFile };

/** All files the Website template seeds into a new app repo. */
export function websiteFiles(name: string, slug: string): ScaffoldFile[] {
  return [
    ...viteBaseFiles(name, slug),
    srcMainTsx(),
    srcSectionsTsx(name),
    srcAppTsx(name),
    appYaml(name),
    decisionsMd(name),
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

// -------------------------------------------------------------- src/sections.tsx --

function srcSectionsTsx(name: string): ScaffoldFile {
  return {
    path: 'src/sections.tsx',
    content: [
      '/**',
      ' * The site SECTIONS registry — one entry = one nav link + one page section.',
      ' *',
      ' * EPICS ADD SECTIONS HERE: create a component (inline or under src/sections/)',
      " * and register it below. The nav and the page render straight from this list.",
      ' */',
      "import type { ReactNode } from 'react';",
      '',
      'export type Section = { id: string; title: string; body: ReactNode };',
      '',
      'export const SECTIONS: Section[] = [',
      '  {',
      "    id: 'about',",
      "    title: 'About',",
      '    body: (',
      '      <p>',
      `        ${name} is a new site. Replace this placeholder with what you do,`,
      '        who it is for, and why it matters.',
      '      </p>',
      '    ),',
      '  },',
      '  {',
      "    id: 'contact',",
      "    title: 'Contact',",
      '    body: <p>Put a real way to reach you here — an address, a form, a mail link.</p>,',
      '  },',
      '  // EPICS ADD SECTIONS HERE',
      '];',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------ src/App.tsx --

function srcAppTsx(name: string): ScaffoldFile {
  return {
    path: 'src/App.tsx',
    content: [
      '/**',
      ' * A PUBLIC site — open to everyone, no gated chrome of any kind. It borrows',
      ' * the OS theme TOKENS (--sb-*) from @sovereign-os/ui/theme.css (imported in',
      ' * src/index.css) for visual coherence — clean typography, calm spacing.',
      ' */',
      "import { SECTIONS } from './sections.tsx';",
      '',
      'export default function App() {',
      '  return (',
      "    <div style={{ fontFamily: 'var(--sb-font-body, system-ui, sans-serif)', color: 'var(--sb-text, #1a1a1a)', background: 'var(--sb-bg, #fff)', minHeight: '100vh' }}>",
      "      <header style={{ maxWidth: 880, margin: '0 auto', padding: '20px 24px', display: 'flex', gap: 16, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>",
      `        <strong style={{ fontSize: 18 }}>${name}</strong>`,
      '        <nav style={{ display: \'flex\', gap: 16 }}>',
      '          {SECTIONS.map((s) => (',
      '            <a key={s.id} href={`#${s.id}`} style={{ color: \'inherit\', textDecoration: \'none\', opacity: 0.8 }}>',
      '              {s.title}',
      '            </a>',
      '          ))}',
      '        </nav>',
      '      </header>',
      '',
      "      <main style={{ maxWidth: 880, margin: '0 auto', padding: '48px 24px' }}>",
      "        <section id=\"home\" style={{ padding: '48px 0 24px' }}>",
      `          <h1 style={{ fontSize: 40, lineHeight: 1.15, margin: 0 }}>${name}</h1>`,
      "          <p style={{ fontSize: 18, opacity: 0.75, maxWidth: 560 }}>",
      '            A public site, ready to shape. Each epic adds a page or section — start',
      '            with the hero line above.',
      '          </p>',
      '        </section>',
      '        {SECTIONS.map((s) => (',
      "          <section key={s.id} id={s.id} style={{ padding: '24px 0', borderTop: '1px solid var(--sb-border, #e5e5e5)' }}>",
      '            <h2 style={{ fontSize: 24, marginTop: 0 }}>{s.title}</h2>',
      '            {s.body}',
      '          </section>',
      '        ))}',
      '      </main>',
      '',
      "      <footer style={{ maxWidth: 880, margin: '0 auto', padding: '24px', opacity: 0.6, fontSize: 13, borderTop: '1px solid var(--sb-border, #e5e5e5)' }}>",
      `        © ${name}`,
      '      </footer>',
      '    </div>',
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
      `description: '${name} — a public website built in the Software tab.'`,
      '# A website serves a UI (and nothing else).',
      'surface: ui',
      'declares:',
      '  connections: []',
      '  data: []',
      '  knowledge: []',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------ .app/decisions.md --

function decisionsMd(name: string): ScaffoldFile {
  return {
    path: '.app/decisions.md',
    content: [
      `# ${name} — design decisions`,
      '',
      '- **Kind:** public website — NO sign-in, NO admin, NO identity chrome.',
      '- **Stack:** Vite + React + TypeScript; OS theme tokens (`@sovereign-os/ui/theme.css`) for coherence.',
      '- **Structure:** one SECTIONS registry (src/sections.tsx) drives nav + page.',
      '- **Served by:** nginx on port 8080 (multi-stage Docker build), same CI as every app.',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------------- README --

/** The website contract — also injected as the app's docs for the build agent. */
export function websiteGuide(name: string): string {
  return [
    `# ${name} — website`,
    '',
    'A PUBLIC-FACING site: no sign-in, no admin, no identity. Keep it that way unless',
    'a story explicitly asks for gated content.',
    '',
    '## How epics add pages',
    '',
    '1. Write the section/page component (inline or under `src/sections/`).',
    '2. Register it in `SECTIONS` (src/sections.tsx) — one entry = nav link + section.',
    '3. Keep the typography calm: the OS theme tokens (`--sb-*`) are already imported',
    '   in `src/index.css`; use them rather than new colour systems.',
    '',
    '## Serving',
    '',
    'Vite build → `dist/` → nginx on port 8080; the sovereign CI workflow builds and',
    'pushes the image on every push to main.',
  ].join('\n');
}

function readmeMd(name: string, _slug: string): ScaffoldFile {
  return { path: 'README.md', content: websiteGuide(name) + '\n' };
}

/** The canonical file paths produced by this template (for test assertions). */
export const WEBSITE_EXPECTED_PATHS = [
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
  'src/sections.tsx',
  'src/App.tsx',
  'app.yaml',
  '.app/decisions.md',
  'README.md',
];
