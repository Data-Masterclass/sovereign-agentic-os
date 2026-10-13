/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The APIs-ONLY template — a minimal governed API service with NO user interface.
 *
 * PURE DATA (`{path,content}[]`) like every scaffold module. Honest about what
 * the platform supports today: the runner serves ONE container listening on
 * port 8080 (TCP readiness probe, per-app host + ingress) — so an API app is a
 * zero-dependency Node HTTP server on 8080. `surface: api` is DECLARED in
 * app.yaml so the app is never mislabeled as a UI app anywhere in the OS.
 *
 * Contract (README): epics add endpoints — one handler in the ROUTES table of
 * server.mjs + a matching path in openapi.yaml (which feeds the auto-MCP tools).
 * Shares the SAME sovereign CI workflow as every other scaffold.
 */
import { ciWorkflowFile, type ScaffoldFile } from './vite-os.ts';

export type { ScaffoldFile };

/** All files the APIs-only template seeds into a new app repo. */
export function apiServiceFiles(name: string, slug: string): ScaffoldFile[] {
  return [
    packageJson(slug),
    serverMjs(name, slug),
    dockerfile(),
    ciWorkflowFile(slug),
    openApiYaml(slug),
    appYaml(name),
    decisionsMd(name),
    readmeMd(name, slug),
  ];
}

// ----------------------------------------------------------------- package.json --

function packageJson(slug: string): ScaffoldFile {
  // ZERO runtime dependencies: node:http only. Nothing to install, nothing to
  // audit — the Docker build is a copy, and the image starts in milliseconds.
  const pkg = {
    name: slug,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { start: 'node server.mjs' },
  };
  return { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' };
}

// ------------------------------------------------------------------- server.mjs --

function serverMjs(name: string, slug: string): ScaffoldFile {
  return {
    path: 'server.mjs',
    content: [
      '/**',
      ` * ${name} — a minimal governed API service (no UI).`,
      ' *',
      ' * EPICS ADD ENDPOINTS HERE: add a handler to ROUTES below and document the',
      ' * path in openapi.yaml (the OS derives the governed MCP tools from it).',
      ' * Zero dependencies: node:http only. The runner probes TCP 8080.',
      ' */',
      "import { createServer } from 'node:http';",
      "import { readFileSync } from 'node:fs';",
      '',
      'const PORT = 8080;',
      '',
      'function json(res, status, body) {',
      "  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });",
      '  res.end(JSON.stringify(body));',
      '}',
      '',
      '/** method+path → handler. One entry per endpoint; epics extend this table. */',
      'const ROUTES = {',
      "  'GET /healthz': (res) => json(res, 200, { ok: true }),",
      `  'GET /api/hello': (res) => json(res, 200, { app: '${slug}', message: 'Hello from ${name}.' }),`,
      "  'GET /openapi.yaml': (res) => {",
      "    res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });",
      "    res.end(readFileSync(new URL('./openapi.yaml', import.meta.url)));",
      '  },',
      '  // EPICS ADD ENDPOINTS HERE',
      '};',
      '',
      'createServer((req, res) => {',
      "  const path = (req.url ?? '/').split('?')[0];",
      '  const handler = ROUTES[`${req.method} ${path}`];',
      "  if (handler) return handler(res, req);",
      "  json(res, 404, { error: 'Not found', hint: 'See /openapi.yaml for the API surface.' });",
      '}).listen(PORT, () => {',
      '  console.log(`listening on :${PORT}`);',
      '});',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------- Dockerfile --

function dockerfile(): ScaffoldFile {
  return {
    path: 'Dockerfile',
    content: [
      '# APIs-only service — zero dependencies, so the build is a straight copy.',
      'FROM node:22-alpine',
      'WORKDIR /app',
      'COPY . .',
      '# Run as the built-in non-root `node` user so the OS runner can enforce a',
      '# hardened securityContext (runAsNonRoot, drop ALL caps). NUMERIC uid — the',
      '# kubelet can only verify runAsNonRoot against a numeric image user, never a',
      '# name. Listens on 8080 (>1024, no NET_BIND_SERVICE capability needed).',
      'USER 1000',
      '# The OS app runner probes TCP 8080.',
      'EXPOSE 8080',
      'CMD ["node", "server.mjs"]',
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
      '  /healthz:',
      "    get: { operationId: healthz, summary: 'Liveness/readiness (read).' }",
      '  /api/hello:',
      `    get: { operationId: hello, summary: 'Hello from ${slug} (read).' }`,
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
      `description: '${name} — an APIs-only service built in the Software tab.'`,
      '# DECLARED headless: this app has no user interface, only endpoints.',
      'surface: api',
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
      '- **Kind:** APIs only — headless, `surface: api`, no UI is ever served.',
      '- **Stack:** zero-dependency Node (node:http) on port 8080; ROUTES table in server.mjs.',
      '- **Contract:** every endpoint is declared in openapi.yaml (feeds the governed MCP tools).',
      '- **Deployed by:** the same sovereign CI → registry → runner path as every app.',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------------- README --

/** The API contract — also injected as the app's docs for the build agent. */
export function apiServiceGuide(name: string): string {
  return [
    `# ${name} — APIs only`,
    '',
    'A headless service: NO user interface, ever (`surface: api` in app.yaml keeps the',
    'OS honest about that). Its capabilities are its endpoints.',
    '',
    '## How epics add endpoints',
    '',
    '1. Add a handler to the `ROUTES` table in `server.mjs` (`"METHOD /path"` → handler).',
    '2. Declare the path in `openapi.yaml` — the OS derives the governed MCP tools from it.',
    '3. Keep the service zero-dependency (node:http); if a story truly needs a package,',
    '   state it as a design decision first.',
    '',
    '## Serving',
    '',
    'One container listening on port 8080 (TCP readiness probe); the sovereign CI',
    'workflow builds and pushes the image on every push to main.',
  ].join('\n');
}

function readmeMd(name: string, _slug: string): ScaffoldFile {
  return { path: 'README.md', content: apiServiceGuide(name) + '\n' };
}

/** The canonical file paths produced by this template (for test assertions). */
export const API_SERVICE_EXPECTED_PATHS = [
  'package.json',
  'server.mjs',
  'Dockerfile',
  '.forgejo/workflows/ci.yml',
  'openapi.yaml',
  'app.yaml',
  '.app/decisions.md',
  'README.md',
];
