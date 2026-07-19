/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Vite + React + TypeScript + Tailwind + shadcn/ui OS-app scaffold.
 *
 * This module is PURE DATA — a `{path, content}[]` array (ScaffoldFile[]) that the
 * repo seeder (apps.ts scaffoldRepo) writes into the per-app Forgejo repo.  It has
 * NO server-only imports and is never compiled as live os-ui source.
 *
 * Every dependency uses a permissive (MIT / Apache-2.0 / BSD) license. No GPL / AGPL
 * / proprietary packages are included.
 *
 * The generated SPA wires itself to the Sovereign Agentic OS via
 * `import { createOsClient } from '@sovereign-os/app-sdk'` and shows the app's
 * granted context (datasets, metrics, knowledge) plus one live sample on boot — so
 * a brand-new app already renders real governed data.
 */

export type ScaffoldFile = { path: string; content: string };

/** All files the Vite OS template seeds into a new app repo (path → content). */
export function viteOsFiles(name: string, slug: string): ScaffoldFile[] {
  return [
    packageJson(slug),
    viteConfig(),
    tsConfig(),
    indexHtml(name),
    tailwindConfig(),
    postcssConfig(),
    viteOsIndexCss(),
    srcMainTsx(),
    srcAppTsx(name),
    srcOsTs(),
    dockerfile(),
    nginxConf(),
    dotforgejoWorkflow(slug),
    appYaml(name, slug),
    openApiYaml(slug),
    decisionsMd(name),
    readmeMd(name, slug),
  ];
}

// ----------------------------------------------------------------- package.json --

function packageJson(slug: string): ScaffoldFile {
  const pkg = {
    name: slug,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc -b && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      // React — MIT
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      // Tailwind runtime utility class merging (kept for custom work) — MIT
      clsx: '^2.1.1',
      'tailwind-merge': '^2.5.4',
      // OS design system — theme + AppShell + primitives — Apache-2.0 (internal, vendored)
      '@sovereign-os/ui': '^0.1.0',
      // OS client SDK — Apache-2.0 (internal package)
      '@sovereign-os/app-sdk': '^0.1.0',
    },
    devDependencies: {
      // Vite — MIT
      vite: '^5.4.2',
      '@vitejs/plugin-react': '^4.3.1',
      // TypeScript — Apache-2.0
      typescript: '^5.5.3',
      '@types/react': '^18.3.5',
      '@types/react-dom': '^18.3.0',
      // Tailwind CSS — MIT
      tailwindcss: '^3.4.10',
      autoprefixer: '^10.4.20',
      postcss: '^8.4.47',
    },
  };
  return { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' };
}

// ---------------------------------------------------------------- vite.config.ts --

function viteConfig(): ScaffoldFile {
  return {
    path: 'vite.config.ts',
    content: [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      '',
      '// https://vite.dev/config/',
      'export default defineConfig({',
      '  plugins: [react()],',
      '  // Build to dist/ — nginx serves from there (see Dockerfile).',
      "  build: { outDir: 'dist' },",
      '});',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------ tsconfig.json --

function tsConfig(): ScaffoldFile {
  const cfg = {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
    },
    include: ['src'],
  };
  return { path: 'tsconfig.json', content: JSON.stringify(cfg, null, 2) + '\n' };
}

// -------------------------------------------------------------------- index.html --

function indexHtml(name: string): ScaffoldFile {
  return {
    path: 'index.html',
    content: [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `    <title>${name}</title>`,
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
  };
}

// --------------------------------------------------------------- tailwind.config.js --

function tailwindConfig(): ScaffoldFile {
  return {
    path: 'tailwind.config.js',
    content: [
      '/** @type {import(\'tailwindcss\').Config} */',
      'export default {',
      "  content: ['./index.html', './src/**/*.{ts,tsx}'],",
      '  theme: {',
      '    extend: {},',
      '  },',
      '  plugins: [],',
      '};',
      '',
    ].join('\n'),
  };
}

// --------------------------------------------------------------- postcss.config.js --

function postcssConfig(): ScaffoldFile {
  return {
    path: 'postcss.config.js',
    content: [
      "import tailwindcss from 'tailwindcss';",
      "import autoprefixer from 'autoprefixer';",
      '',
      'export default {',
      '  plugins: [tailwindcss, autoprefixer],',
      '};',
      '',
    ].join('\n'),
  };
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
      '// Boot in the OS dark-luxury look (gold-on-black). Remove this line for the',
      "// light theme — the .sb-* chrome adapts to both. Nav chrome stays dark either way.",
      "document.documentElement.setAttribute('data-theme', 'dark');",
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
//
// The starter page: calls os.whoami() + os.context() and renders the app's granted
// context (datasets / metrics / knowledge) + one live metric sample — wrapped in the
// OS chrome (`AppShell`) with the OS primitives (Section, Card, Table, Badge). The
// topbar shows the LIVE logged-in user (os.whoami). Honest loading / empty / error
// states. It looks like it belongs to the Sovereign OS out of the box, and every
// class/token stays overridable (Tailwind is still available for custom work).

function srcAppTsx(name: string): ScaffoldFile {
  return {
    path: 'src/App.tsx',
    content: [
      "import { useEffect, useState, type ReactElement } from 'react';",
      "import type { OsContext, WhoAmI } from '@sovereign-os/app-sdk';",
      "import { AppShell, Section, Card, Table, Badge } from '@sovereign-os/ui';",
      "import { createOsClient } from './os.ts';",
      '',
      '// ContextItem shape (id + name) as returned by os.context() — each kind is an array.',
      'type ContextItem = { id: string; name: string };',
      '',
      'const os = createOsClient();',
      '',
      'export default function App() {',
      '  const [whoami, setWhoami] = useState<WhoAmI | null>(null);',
      '  const [ctx, setCtx] = useState<OsContext | null>(null);',
      '  // os.metrics.query returns unknown; we only display a JSON preview.',
      '  const [sample, setSample] = useState<{ metricName: string; result: unknown } | null>(null);',
      "  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');",
      '  const [error, setError] = useState<string | null>(null);',
      '',
      '  useEffect(() => {',
      '    let cancelled = false;',
      '    (async () => {',
      '      try {',
      '        const [me, context] = await Promise.all([os.whoami(), os.context()]);',
      '        if (cancelled) return;',
      '        setWhoami(me);',
      '        setCtx(context);',
      '        // Pull one live metric sample if any metrics are granted.',
      '        if (context.metrics.length > 0) {',
      '          const first = context.metrics[0];',
      '          try {',
      '            const result = await os.metrics.query(first.id);',
      '            if (!cancelled) setSample({ metricName: first.name, result });',
      '          } catch {',
      '            /* metric unavailable — show context without it */',
      '          }',
      '        }',
      "        if (!cancelled) setPhase('ready');",
      '      } catch (e) {',
      '        if (cancelled) return;',
      "        setError(e instanceof Error ? e.message : 'Unknown error');",
      "        setPhase('error');",
      '      }',
      '    })();',
      '    return () => { cancelled = true; };',
      '  }, []);',
      '',
      '  // ctx is OsContext: { data, metrics, knowledge, connections, files } — each ContextItem[].',
      '  const datasets: ContextItem[] = ctx?.data ?? [];',
      '  const metricRefs: ContextItem[] = ctx?.metrics ?? [];',
      '  const knowledge: ContextItem[] = ctx?.knowledge ?? [];',
      '  const user = whoami?.user ?? null;',
      '  const username = user ? String(user.username ?? user.id) : null;',
      "  const role = user && user.role != null ? String(user.role) : null;",
      '',
      '  // The live logged-in user, shown in the topbar and sidebar footer.',
      '  const userChip =',
      '    username != null ? (',
      "      <span className=\"sb-crumb\" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>",
      '        <strong>{username}</strong>',
      '        {role && <Badge tone="muted">{role}</Badge>}',
      '      </span>',
      '    ) : null;',
      '',
      '  // The app’s OWN nav — order preserved. Wire these to your real routes.',
      '  const nav = [',
      "    { label: 'Overview', icon: '◇', href: '#', active: true },",
      "    { label: 'Datasets', icon: '▤', href: '#datasets' },",
      "    { label: 'Metrics', icon: '▰', href: '#metrics' },",
      "    { label: 'Knowledge', icon: '◈', href: '#knowledge' },",
      '  ];',
      '',
      '  const shell = (body: ReactElement) => (',
      '    <AppShell',
      `      brand=${JSON.stringify(name)}`,
      '      brandSub="Powered by Sovereign OS"',
      '      nav={nav}',
      `      title=${JSON.stringify(name)}`,
      '      crumb="Overview"',
      '      topbarRight={userChip}',
      '      sidebarFooter={username != null ? (<>Signed in as <strong>{username}</strong></>) : null}',
      '    >',
      '      {body}',
      '    </AppShell>',
      '  );',
      '',
      "  if (phase === 'loading') {",
      '    return shell(',
      "      <Section title=\"Loading\"><Card><span className=\"sb-muted\">Connecting to the Sovereign OS…</span></Card></Section>,",
      '    );',
      '  }',
      '',
      "  if (phase === 'error') {",
      '    return shell(',
      '      <Section title="Could not connect">',
      '        <Card>',
      '          <h3>OS unreachable</h3>',
      '          <p className="sb-muted">{error}</p>',
      '          <div style={{ marginTop: 10 }}><Badge tone="err">Offline</Badge></div>',
      '        </Card>',
      '      </Section>,',
      '    );',
      '  }',
      '',
      '  const empty = datasets.length === 0 && metricRefs.length === 0 && knowledge.length === 0;',
      '',
      '  return shell(',
      '    <>',
      '      {/* KPI row — the governed context this app can reach, at a glance. */}',
      '      <Section title="Granted context">',
      '        <div className="sb-grid">',
      '          <Card>',
      '            <h3>Datasets</h3>',
      '            <div className="sb-big">{datasets.length}</div>',
      '            <div className="sb-muted">governed tables</div>',
      '          </Card>',
      '          <Card>',
      '            <h3>Metrics</h3>',
      '            <div className="sb-big">{metricRefs.length}</div>',
      '            <div className="sb-muted">defined measures</div>',
      '          </Card>',
      '          <Card>',
      '            <h3>Knowledge</h3>',
      '            <div className="sb-big">{knowledge.length}</div>',
      '            <div className="sb-muted">indexed docs</div>',
      '          </Card>',
      '        </div>',
      '      </Section>',
      '',
      '      {/* Live metric sample — rendered only if a metric is granted and returned. */}',
      '      {sample && (',
      '        <Section title="Live metric" style={{ marginTop: 24 }}>',
      '          <Card>',
      "            <h3>{sample.metricName} <Badge tone=\"ok\">Live</Badge></h3>",
      "            <pre className=\"sb-mono\" style={{ marginTop: 10, fontSize: 12, overflow: 'auto', color: 'var(--sb-text-muted)' }}>",
      '              {JSON.stringify(sample.result, null, 2)}',
      '            </pre>',
      '          </Card>',
      '        </Section>',
      '      )}',
      '',
      '      {/* The granted artifacts, as an OS table. */}',
      '      {!empty && (',
      '        <Section title="Granted artifacts" style={{ marginTop: 24 }}>',
      '          <Table>',
      '            <thead><tr><th>Kind</th><th>Name</th></tr></thead>',
      '            <tbody>',
      "              {datasets.map((d) => (<tr key={'d-' + d.id}><td><Badge>Dataset</Badge></td><td className=\"sb-mono\">{d.name}</td></tr>))}",
      "              {metricRefs.map((m) => (<tr key={'m-' + m.id}><td><Badge tone=\"muted\">Metric</Badge></td><td className=\"sb-mono\">{m.name}</td></tr>))}",
      "              {knowledge.map((k) => (<tr key={'k-' + k.id}><td><Badge tone=\"muted\">Knowledge</Badge></td><td className=\"sb-mono\">{k.name}</td></tr>))}",
      '            </tbody>',
      '          </Table>',
      '        </Section>',
      '      )}',
      '',
      '      {/* Empty state — no grants yet. */}',
      '      {empty && (',
      '        <Section title="No context yet" style={{ marginTop: 24 }}>',
      '          <Card>',
      '            <h3>Nothing granted</h3>',
      '            <p className="sb-muted">',
      '              No governed context granted yet. Ask a domain admin to add datasets,',
      '              metrics or knowledge to this app.',
      '            </p>',
      '          </Card>',
      '        </Section>',
      '      )}',
      '    </>,',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------ src/os.ts --
//
// Thin factory wrapper around `@sovereign-os/app-sdk`.  Reads the OS API base URL
// from the VITE_OS_API env var injected at container build time.

function srcOsTs(): ScaffoldFile {
  return {
    path: 'src/os.ts',
    content: [
      "import { createOsClient as _create } from '@sovereign-os/app-sdk';",
      '',
      '/**',
      ' * Returns a typed OS client bound to the API base URL injected at build time.',
      " * Import this singleton factory (don't call createOsClient directly) so the",
      ' * base URL is read once and shared across the app.',
      ' *',
      " * In development: set VITE_OS_API=http://localhost:3000 in your .env.local.",
      " * In production: the Dockerfile build arg OS_API_URL is baked in at build time.",
      ' */',
      'export function createOsClient() {',
      "  const base = import.meta.env.VITE_OS_API ?? '';",
      '  return _create({ baseUrl: base });',
      '}',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------------------------- Dockerfile --
//
// Multi-stage build: node:22-alpine builds the SPA, nginx:alpine serves static files
// on port 8080 (the OS runner's probe port).

function dockerfile(): ScaffoldFile {
  return {
    path: 'Dockerfile',
    content: [
      '# Vite OS app — built by Sovereign Agentic OS CI -> Harbor -> Argo CD.',
      '# Stage 1: build the SPA.',
      'FROM node:22-alpine AS builder',
      'WORKDIR /app',
      '# Pass the OS API base URL as a build arg so Vite can bake it into the bundle.',
      'ARG OS_API_URL=""',
      'ENV VITE_OS_API=$OS_API_URL',
      'COPY package.json ./package-lock.json* ./',
      '# Use install (not ci) if no lockfile is committed yet; do NOT swallow errors.',
      'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi',
      'COPY . .',
      'RUN npm run build',
      '',
      '# Stage 2: serve with nginx on 8080 (the OS runner probe port).',
      'FROM nginx:1.27-alpine',
      'COPY --from=builder /app/dist /usr/share/nginx/html',
      'COPY nginx.conf /etc/nginx/conf.d/default.conf',
      'EXPOSE 8080',
      'CMD ["nginx", "-g", "daemon off;"]',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------- nginx.conf --
//
// Minimal config: listen on 8080, fall back to index.html for SPA routing.

function nginxConf(): ScaffoldFile {
  return {
    path: 'nginx.conf',
    content: [
      'server {',
      '    listen 8080;',
      '    server_name _;',
      '    root /usr/share/nginx/html;',
      '    index index.html;',
      '',
      '    # SPA fallback: any path that does not match a real file serves index.html.',
      '    location / {',
      '        try_files $uri $uri/ /index.html;',
      '    }',
      '',
      '    # Disable server tokens (no nginx version in headers).',
      '    server_tokens off;',
      '',
      '    # Gzip static assets.',
      '    gzip on;',
      '    gzip_types text/plain text/css application/javascript application/json image/svg+xml;',
      '}',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------- .forgejo/workflows/ci.yml --
//
// Exactly the same sovereign CI workflow used by the nextjs-supabase template —
// checkout → build image → push to the in-cluster registry → the runner pulls it.

function dotforgejoWorkflow(slug: string): ScaffoldFile {
  return {
    path: '.forgejo/workflows/ci.yml',
    content: [
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  build-and-push:',
      '    runs-on: docker',
      '    env:',
      '      DOCKER_HOST: tcp://localhost:2375',
      '      REGISTRY: forgejo-http:3000',
      '      OWNER: gitea_admin',
      `      REPO: ${slug}`,
      '    steps:',
      '      - name: Checkout (manual — sovereign, no github.com)',
      '        env: { REG_PASS: "${{ secrets.REGISTRY_PASS }}" }',
      '        run: |',
      '          set -eu',
      '          git clone --depth 1 "http://${OWNER}:${REG_PASS}@${REGISTRY}/${OWNER}/${REPO}.git" src',
      '      - name: Build & push image',
      '        env: { REG_PASS: "${{ secrets.REGISTRY_PASS }}" }',
      '        run: |',
      '          set -eu',
      '          TAG="$(echo "${GITHUB_SHA}" | cut -c1-12)"',
      '          IMAGE="${REGISTRY}/${OWNER}/${REPO}"',
      '          echo "${REG_PASS}" | docker login "${REGISTRY}" -u "${OWNER}" --password-stdin',
      '          docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" ./src',
      '          docker push "${IMAGE}:${TAG}"',
      '          docker push "${IMAGE}:latest"',
    ].join('\n') + '\n',
  };
}

// -------------------------------------------------------------------- app.yaml --

function appYaml(name: string, slug: string): ScaffoldFile {
  return {
    path: 'app.yaml',
    content: [
      'apiVersion: software.sovereign-os/v1',
      'kind: App',
      `name: '${name}'`,
      `owner: gitea_admin`,
      `description: '${name} — built in the Software tab.'`,
      '# Declare the surface so the monitor shows the UI link from day one.',
      'surface: ui',
      'declares:',
      '  connections: []',
      '  data: []',
      '  knowledge: []',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------- openapi.yaml --

function openApiYaml(slug: string): ScaffoldFile {
  return {
    path: 'openapi.yaml',
    content: [
      'openapi: 3.0.0',
      'info:',
      `  title: ${slug}`,
      '  version: 1.0.0',
      'paths:',
      '  /records:',
      `    get: { operationId: list_records, summary: 'List ${slug} records (read).' }`,
      `    post: { operationId: add_record, summary: 'Add a ${slug} record (write).' }`,
      "  '/records/{id}':",
      "    get: { operationId: get_record, summary: 'Get one record by id (read).' }",
      '  /export:',
      "    post: { operationId: export_records, summary: 'Export records to a file (write).' }",
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
      'Captured under the app and versioned in git.',
      '',
      '## Stack',
      '',
      '- **Frontend:** Vite + React + TypeScript + Tailwind CSS',
      '- **Design system:** `@sovereign-os/ui` — the OS theme + `AppShell` + primitives (vendored, Apache-2.0)',
      '- **OS integration:** `@sovereign-os/app-sdk` — `os.whoami()`, `os.context()`, `os.metrics.query()`',
      '- **Served by:** nginx on port 8080 (multi-stage Docker build)',
      '- **Deployed by:** Sovereign Agentic OS CI → Harbor → Argo CD',
      '',
      '## Data access',
      '',
      'The app reads governed context (datasets / metrics / knowledge) through the OS SDK.',
      'No raw credentials are embedded — all access is mediated by OPA-governed grants.',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------------- README --

function readmeMd(name: string, slug: string): ScaffoldFile {
  return {
    path: 'README.md',
    content: [
      `# ${name}`,
      '',
      'A **governed OS app** built with the Sovereign Agentic OS Software tab.',
      '',
      '## What this is',
      '',
      'This is a **Vite + React + TypeScript + Tailwind CSS** SPA that wears the Sovereign OS',
      'design language via `@sovereign-os/ui` (theme + `AppShell` + primitives) and talks to the',
      'Sovereign Agentic OS API via `@sovereign-os/app-sdk`. It is a *frontend* over the OS',
      "API — all data access goes through the OS's OPA-enforced governed layer, not raw",
      'database credentials.',
      '',
      '## Development',
      '',
      '```sh',
      'npm install',
      '# Set the OS API base URL for local dev:',
      'echo "VITE_OS_API=http://localhost:3000" > .env.local',
      'npm run dev',
      '```',
      '',
      '## Production',
      '',
      'The CI workflow (`.forgejo/workflows/ci.yml`) builds a multi-stage Docker image:',
      '',
      '1. **Stage 1 (node:22-alpine):** `npm run build` compiles the SPA to `dist/`.',
      '2. **Stage 2 (nginx:1.27-alpine):** serves `dist/` as static files on **port 8080**.',
      '',
      `The image is published to the in-cluster registry as \`gitea_admin/${slug}:latest\``,
      'and Argo CD syncs it to `https://' + slug + '.<domain>`.',
      '',
      '## OS context',
      '',
      'On boot the app calls `os.whoami()` and `os.context()` to display the governed',
      'context the domain admin has granted — datasets, metrics, knowledge — plus one live',
      'metric sample. Replace the starter page (`src/App.tsx`) with your real UI.',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------- src/index.css --
//
// Minimal Tailwind entry — imported by main.tsx.
// (Included as a named helper so the public API surface is complete.)
export function viteOsIndexCss(): ScaffoldFile {
  return {
    path: 'src/index.css',
    content: [
      '/* The Sovereign OS design language (tokens, typography, .sb-* chrome).',
      '   Imported ONCE here so the whole app inherits the OS look. Fully',
      '   overridable — redefine any --sb-* token below or add your own classes. */',
      "@import '@sovereign-os/ui/theme.css';",
      '',
      '/* Tailwind stays available for custom work alongside the OS chrome. */',
      '@tailwind base;',
      '@tailwind components;',
      '@tailwind utilities;',
      '',
    ].join('\n'),
  };
}

/**
 * ALL files for the Vite OS template. `viteOsFiles` is now the canonical, complete
 * seeder (it already includes `src/index.css`), so this is a thin alias kept for the
 * tests and any caller that wants the full, self-consistent set.
 */
export function viteOsAllFiles(name: string, slug: string): ScaffoldFile[] {
  return viteOsFiles(name, slug);
}

/** The canonical file paths produced by this template (for test assertions). */
export const VITE_OS_EXPECTED_PATHS = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
  'tailwind.config.js',
  'postcss.config.js',
  'src/index.css',
  'src/main.tsx',
  'src/App.tsx',
  'src/os.ts',
  'Dockerfile',
  'nginx.conf',
  '.forgejo/workflows/ci.yml',
  'app.yaml',
  'openapi.yaml',
  '.app/decisions.md',
  'README.md',
];
