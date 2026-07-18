/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAppManifest,
  renderAppYaml,
  parseOpenApi,
  defaultOpenApi,
  detectSurface,
  resolveSurface,
  parseSurfaceDeclaration,
  reconcileKnowledgeConsumes,
} from './metadata.ts';
import type { ConsumedResource } from './model.ts';

test('app.yaml convention is parsed into the manifest (declared resources)', () => {
  const appYaml = renderAppYaml({
    name: 'Renewals Tracker',
    owner: 'alice',
    description: 'Track renewals',
    connections: ['salesforce'],
    data: ['accounts'],
    knowledge: ['discount-policy'],
  });
  const m = parseAppManifest(
    [
      { path: 'app.yaml', content: appYaml },
      { path: 'openapi.yaml', content: defaultOpenApi('renewals') },
      { path: '.app/decisions.md', content: '# decisions' },
    ],
    { name: 'fallback', owner: 'fallback' },
  );
  assert.equal(m.name, 'Renewals Tracker');
  assert.equal(m.owner, 'alice');
  assert.deepEqual(m.connections, ['salesforce']);
  assert.deepEqual(m.knowledge, ['discount-policy']);
  assert.equal(m.hasOpenApi, true);
  assert.equal(m.missing.length, 0);
});

test('imported/legacy repo (no app.yaml) derives what it can + flags the rest', () => {
  const m = parseAppManifest(
    [{ path: 'README.md', content: '# Orders API\nA legacy orders service.\n' }],
    { name: 'orders-api', owner: 'bob' },
  );
  assert.equal(m.name, 'orders-api');
  assert.equal(m.description.includes('legacy orders service'), true);
  assert.equal(m.missing.includes('app.yaml'), true);
  assert.equal(m.hasOpenApi, false);
  assert.equal(m.missing.some((x) => x.startsWith('openapi')), true);
});

test('parseOpenApi reads a committed spec', () => {
  const spec = parseOpenApi([{ path: 'openapi.yaml', content: defaultOpenApi('x') }]);
  assert.ok(spec);
  assert.ok(spec!.paths['/renewals']);
});

test('detectSurface: a Next.js app with an OpenAPI spec exposes BOTH ui + api', () => {
  const s = detectSurface([
    { path: 'package.json', content: JSON.stringify({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }) },
    { path: 'openapi.yaml', content: defaultOpenApi('renewals') },
    { path: 'app/page.tsx', content: 'export default function Page() { return null; }' },
  ]);
  assert.deepEqual(s, { ui: true, api: true });
});

test('detectSurface: a headless service (Python entrypoint, no frontend) is api-only', () => {
  const s = detectSurface([
    { path: 'main.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n' },
    { path: 'requirements.txt', content: 'fastapi\n' },
  ]);
  assert.deepEqual(s, { ui: false, api: true });
});

test('detectSurface: a static HTML site with no API is ui-only', () => {
  const s = detectSurface([
    { path: 'public/index.html', content: '<!doctype html><title>site</title>' },
  ]);
  assert.deepEqual(s, { ui: true, api: false });
});

test('detectSurface: nothing detectable falls back to a headless api surface', () => {
  const s = detectSurface([{ path: 'README.md', content: '# just docs' }]);
  assert.deepEqual(s, { ui: false, api: true });
});

// -------------------------------------------------- Broadened UI detection ----

test('detectSurface: a Streamlit app (requirements.txt) reads as UI, not API', () => {
  const s = detectSurface([
    { path: 'requirements.txt', content: 'streamlit\npandas\n' },
    { path: 'app.py', content: 'import streamlit as st\nst.title("hi")\n' },
  ]);
  // app.py still counts as an api entrypoint by convention, but it MUST read UI too.
  assert.equal(s.ui, true, 'a Streamlit app is a UI app');
});

test('detectSurface: a Gradio app in a *.py reads as UI', () => {
  const s = detectSurface([
    { path: 'demo.py', content: 'import gradio as gr\ngr.Interface(fn=lambda x: x, inputs="text", outputs="text").launch()\n' },
  ]);
  assert.equal(s.ui, true);
});

test('detectSurface: a Flask app with templates/ + render_template reads as UI', () => {
  const s = detectSurface([
    { path: 'server.py', content: 'from flask import Flask, render_template\napp = Flask(__name__)\n' },
    { path: 'templates/index.html', content: '<h1>{{ title }}</h1>' },
  ]);
  assert.equal(s.ui, true, 'server-rendered HTML is a UI');
  assert.equal(s.api, true, 'Flask still exposes endpoints');
});

test('detectSurface: FastAPI mounting StaticFiles reads as UI + API', () => {
  const s = detectSurface([
    { path: 'main.py', content: 'from fastapi import FastAPI\nfrom fastapi.staticfiles import StaticFiles\napp = FastAPI()\napp.mount("/", StaticFiles(directory="static"), name="static")\n' },
    { path: 'static/index.html', content: '<!doctype html><title>site</title>' },
  ]);
  assert.deepEqual(s, { ui: true, api: true });
});

test('detectSurface: a top-level index.html anywhere reads as UI', () => {
  const s = detectSurface([{ path: 'index.html', content: '<!doctype html>' }]);
  assert.equal(s.ui, true);
});

test('detectSurface: a Dockerfile that EXPOSEs a web port + runs streamlit reads as UI', () => {
  const s = detectSurface([
    { path: 'Dockerfile', content: 'FROM python:3.12\nEXPOSE 8080\nCMD ["streamlit", "run", "app.py"]\n' },
    { path: 'app.py', content: 'print("build me")\n' },
  ]);
  assert.equal(s.ui, true);
});

test('detectSurface: a pure headless FastAPI (no UI shapes) is still api-only', () => {
  const s = detectSurface([
    { path: 'main.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health():\n    return {"ok": True}\n' },
    { path: 'requirements.txt', content: 'fastapi\nuvicorn\n' },
  ]);
  assert.deepEqual(s, { ui: false, api: true }, 'honest: a real headless API is NOT marked UI');
});

// ------------------------------------------------ Declaration wins over detect -

test('surface declaration (app.yaml surface: ui) WINS over the heuristic', () => {
  // These files look headless (python entrypoint), but the app DECLARES ui.
  const files = [
    { path: 'app.yaml', content: renderAppYaml({ name: 'Widget', owner: 'a', description: '', surface: 'ui' }) },
    { path: 'main.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n' },
  ];
  assert.equal(parseSurfaceDeclaration(files), 'ui');
  assert.deepEqual(resolveSurface(files), { ui: true, api: false }, 'declaration ui → ui-only');
});

test('surface declaration parses into the manifest (declaredSurface)', () => {
  const m = parseAppManifest(
    [{ path: 'app.yaml', content: renderAppYaml({ name: 'X', owner: 'a', description: '', surface: 'both' }) }],
    { name: 'X', owner: 'a' },
  );
  assert.equal(m.declaredSurface, 'both');
});

test('resolveSurface: an explicit override arg beats both manifest + heuristic', () => {
  const files = [{ path: 'main.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n' }];
  assert.deepEqual(resolveSurface(files, 'ui'), { ui: true, api: false });
});

test('back-compat: NO declaration → resolveSurface falls back to detectSurface', () => {
  const files = [
    { path: 'package.json', content: JSON.stringify({ dependencies: { next: '^15.0.0' } }) },
    { path: 'app/page.tsx', content: 'export default function Page() { return null; }' },
  ];
  assert.equal(parseSurfaceDeclaration(files), undefined);
  assert.deepEqual(resolveSurface(files), detectSurface(files));
});

test('renderAppYaml omits surface when undeclared (byte-stable, still on heuristic)', () => {
  const y = renderAppYaml({ name: 'X', owner: 'a', description: '' });
  assert.equal(/(^|\n)surface:/.test(y), false, 'no surface key when not declared');
  const withDecl = renderAppYaml({ name: 'X', owner: 'a', description: '', surface: 'api' });
  assert.equal(/(^|\n)surface: api\b/.test(withDecl), true);
});

test('parseSurfaceDeclaration: an invalid surface value is ignored (→ undefined)', () => {
  const files = [{ path: 'app.yaml', content: 'name: X\nowner: a\nsurface: banana\n' }];
  assert.equal(parseSurfaceDeclaration(files), undefined);
});

test('reconcileKnowledgeConsumes: declares.knowledge is AUTHORITATIVE — adds new, PRUNES removed', () => {
  const consumes: ConsumedResource[] = [
    { kind: 'knowledge', ref: 'wf_old', label: 'Old policy', scope: 'read' },
    { kind: 'knowledge', ref: 'wf_keep', label: 'Kept policy', scope: 'write-bounded' },
    { kind: 'connection', ref: 'salesforce', label: 'Salesforce', scope: 'read' },
    { kind: 'data', ref: 'ds_accounts', label: 'Accounts', scope: 'read' },
  ];
  // Commit declares only wf_keep + a NEW wf_new; wf_old was removed.
  const out = reconcileKnowledgeConsumes(consumes, ['wf_keep', 'wf_new']);

  const knowledge = out.filter((c) => c.kind === 'knowledge').map((c) => c.ref).sort();
  assert.deepEqual(knowledge, ['wf_keep', 'wf_new'], 'wf_old pruned, wf_new added');
  // Retained ref keeps its prior label + scope (not clobbered to a default).
  const keep = out.find((c) => c.ref === 'wf_keep')!;
  assert.equal(keep.label, 'Kept policy');
  assert.equal(keep.scope, 'write-bounded');
  // New ref gets a default read grant.
  const added = out.find((c) => c.ref === 'wf_new')!;
  assert.equal(added.scope, 'read');
  // Non-knowledge consumes are untouched.
  assert.ok(out.some((c) => c.kind === 'connection' && c.ref === 'salesforce'));
  assert.ok(out.some((c) => c.kind === 'data' && c.ref === 'ds_accounts'));
});

test('reconcileKnowledgeConsumes: empty declares drops ALL knowledge edges but keeps data/conn', () => {
  const consumes: ConsumedResource[] = [
    { kind: 'knowledge', ref: 'wf_a', label: 'A', scope: 'read' },
    { kind: 'connection', ref: 'salesforce', label: 'Salesforce', scope: 'read' },
  ];
  const out = reconcileKnowledgeConsumes(consumes, []);
  assert.equal(out.filter((c) => c.kind === 'knowledge').length, 0);
  assert.ok(out.some((c) => c.kind === 'connection'));
});

test('reconcileKnowledgeConsumes: de-dupes a repeated declared ref into one edge', () => {
  const out = reconcileKnowledgeConsumes([], ['wf_x', 'wf_x']);
  assert.equal(out.filter((c) => c.ref === 'wf_x').length, 1);
});
