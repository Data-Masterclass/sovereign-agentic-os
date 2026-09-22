/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the APIs-only scaffold (lib/software/scaffolds/api-service.ts).
 * Headless: `surface: api` DECLARED; zero-dependency Node HTTP server on the
 * runner's port 8080; endpoints contracted via the ROUTES table + openapi.yaml.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiServiceFiles, apiServiceGuide, API_SERVICE_EXPECTED_PATHS } from './api-service.ts';

const SLUG = 'billing-api';
const NAME = 'Billing API';

function files() {
  return apiServiceFiles(NAME, SLUG);
}

function byPath(path: string): string {
  const f = files().find((x) => x.path === path);
  assert.ok(f, `${path} is present in the scaffold`);
  return f!.content;
}

test('api-service scaffold: produces the expected file set — and NO UI files', () => {
  const produced = files().map((f) => f.path).sort();
  assert.deepStrictEqual(produced, [...API_SERVICE_EXPECTED_PATHS].sort());
  assert.ok(!produced.some((p) => p === 'index.html' || p.startsWith('src/')), 'no UI entry ships');
});

test('api-service scaffold: declares surface api so it is never mislabeled', () => {
  assert.match(byPath('app.yaml'), /surface: api/);
});

test('api-service scaffold: zero-dependency server on the runner port 8080', () => {
  const pkg = JSON.parse(byPath('package.json')) as { dependencies?: Record<string, string>; scripts: Record<string, string> };
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.scripts.start, 'node server.mjs');
  const server = byPath('server.mjs');
  assert.match(server, /node:http/, 'stdlib only');
  assert.match(server, /PORT = 8080/, 'listens where the runner probes');
  assert.match(server, /GET \/healthz/, 'has a health endpoint');
  assert.match(server, /EPICS ADD ENDPOINTS HERE/, 'documents where epics add endpoints');
  assert.match(byPath('Dockerfile'), /EXPOSE 8080/);
  assert.match(byPath('Dockerfile'), /CMD \["node", "server\.mjs"\]/);
});

test('api-service scaffold: openapi declares the starter endpoints (feeds auto-MCP)', () => {
  const spec = byPath('openapi.yaml');
  assert.match(spec, /\/healthz/);
  assert.match(spec, /\/api\/hello/);
});

test('api-service scaffold: ships through the same sovereign CI as every app', () => {
  assert.match(byPath('.forgejo/workflows/ci.yml'), /docker push/);
});

test('api-service scaffold: README is the endpoint contract and doubles as docs', () => {
  const readme = byPath('README.md');
  assert.equal(readme, apiServiceGuide(NAME) + '\n');
  assert.match(readme, /ROUTES/, 'names the handler table');
  assert.match(readme, /openapi\.yaml/, 'requires declaring endpoints');
  assert.match(readme, /NO user interface/i, 'states the headless contract');
});
