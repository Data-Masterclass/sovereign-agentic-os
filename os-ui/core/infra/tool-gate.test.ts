/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel infra
 * FEATURE:    Tool consoles — the exposure gate of the /tools/<key> proxy and the short addresses
 * USER STORY: As a platform admin I switch a tool console (LiteLLM, Dagster, ...) on in Platform →
 *             Tool consoles; until I do, /tools/<key>/ answers 404 for everyone, me included, and
 *             once I do only admins get in. The LiteLLM public Model Hub stays a product feature
 *             for every signed-in user, whatever the switch says.
 * ARCHITECTURE:
 *   - `gateToolRequest` is pure: the route reads the switch from the settings store and passes
 *     it in, so the kernel never imports the admin tab.
 *   - Each positive case has a negative twin: off -> 404, non-admin -> 403, pending -> 404.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool } from '@core/infra/tool-proxy';

// The chart sets this when it renders the read-only webserver; `config` reads env at import.
process.env.DAGSTER_READONLY_URL = 'http://agentic-os-dagster-webserver-read-only:80';
const { TOOLS, resolveTool, gateToolRequest, consoleAvailability, shortAddressFor, CONSOLE_ROLE, unsafePathSegment } = await import('@core/infra/tool-proxy');

const ROLES = ['creator', 'builder', 'domain_admin', 'admin'] as const;

test('the console audience is admin', () => {
  assert.equal(CONSOLE_ROLE, 'admin');
});

test('OFF: every console path is 404 for every role, admins included', () => {
  for (const key of Object.keys(TOOLS)) {
    const tool = TOOLS[key];
    for (const role of ROLES) {
      const g = gateToolRequest({ tool, path: ['some', 'page'], role, exposed: false });
      assert.equal(g.status, 404, `${key} for ${role} while off`);
    }
    assert.equal(gateToolRequest({ tool, path: [], role: 'admin', exposed: false }).status, 404, `${key} root while off`);
  }
});

test('ON: an admin gets into an available console; every non-admin gets 403 (negative twin)', () => {
  const litellm = resolveTool('litellm')!;
  const dagster = resolveTool('dagster')!;
  for (const tool of [litellm, dagster]) {
    const ok = gateToolRequest({ tool, path: [], role: 'admin', exposed: true });
    assert.equal(ok.status, 200, `${tool.key}: admin is let in`);
    for (const role of ['creator', 'builder', 'domain_admin'] as const) {
      assert.equal(gateToolRequest({ tool, path: [], role, exposed: true }).status, 403, `${tool.key}: ${role} is refused`);
    }
  }
});

test('LiteLLM admin console: ON + admin carries the server-minted session; OFF it is 404', () => {
  const t = resolveTool('litellm')!;
  const on = gateToolRequest({ tool: t, path: ['ui'], role: 'admin', exposed: true });
  assert.equal(on.status, 200);
  assert.equal(on.needsAdminSso, true);
  assert.equal(gateToolRequest({ tool: t, path: ['ui'], role: 'admin', exposed: false }).status, 404);
  assert.equal(gateToolRequest({ tool: t, path: ['key', 'list'], role: 'admin', exposed: false }).status, 404, 'sub-resources too');
});

test('LiteLLM public Model Hub: open to every signed-in role whether the console is on or off', () => {
  const t = resolveTool('litellm')!;
  for (const exposed of [false, true]) {
    for (const role of ROLES) {
      const g = gateToolRequest({ tool: t, path: ['public', 'model_hub'], role, exposed });
      assert.equal(g.status, 200, `${role}, console ${exposed ? 'on' : 'off'}`);
      assert.equal(g.needsAdminSso, false, 'no credential for the hub');
    }
  }
  // Negative twin: a console path dressed up next to the hub is not public.
  assert.equal(gateToolRequest({ tool: t, path: ['publicity'], role: 'creator', exposed: true }).status, 403);
});

test('a console that cannot be served under /tools stays 404 even when switched on', () => {
  for (const key of ['langfuse', 'jupyterhub', 'opensearch']) {
    const tool = TOOLS[key];
    assert.equal(consoleAvailability(tool).state, 'pending', `${key} is pending`);
    assert.equal(gateToolRequest({ tool, path: [], role: 'admin', exposed: true }).status, 404, `${key} on but pending`);
  }
  for (const key of ['litellm', 'dagster']) {
    assert.equal(consoleAvailability(TOOLS[key]).state, 'available', `${key} is servable`);
  }
});

test('a console with no upstream configured is "not set up" and 404', () => {
  const t: Tool = { ...TOOLS.mlflow, upstream: '' };
  assert.equal(consoleAvailability(t).state, 'not-set-up');
  assert.equal(gateToolRequest({ tool: t, path: [], role: 'admin', exposed: true }).status, 404);
});

test('Dagster is proxied to the READ-ONLY webserver, mounted under the prefix', () => {
  const d = TOOLS.dagster;
  assert.equal(d.ownTab, undefined, 'served through the proxy now, not an own tab');
  assert.equal(d.upstreamRootPath, '/tools/dagster', 'the webserver runs with --path-prefix /tools/dagster');
  assert.equal(d.sso.mode, 'none', 'Dagster OSS has no login: the OS sign-in and the admin gate are the access control');
  assert.equal(d.minRole, 'admin');
});

test('path segments: a dot segment or an embedded separator is refused before anything is proxied', () => {
  for (const bad of [['..'], ['.'], ['a', '..', 'b'], ['a/b'], ['a\\b'], ['x\u0000y']]) {
    assert.equal(unsafePathSegment(bad) !== null, true, JSON.stringify(bad));
  }
  // Negative twins: ordinary names, file names with dots, and hidden-looking names pass.
  for (const ok of [[], ['runs'], ['_next', 'static', 'chunks', 'a.b.js'], ['.well-known'], ['public', 'model_hub']]) {
    assert.equal(unsafePathSegment(ok), null, JSON.stringify(ok));
  }
});

test('OS logout expires the LiteLLM UI session under its prefix (and the logout route sends it)', async () => {
  const { toolSessionCookieExpiries } = await import('@core/infra/tool-proxy');
  const lines = toolSessionCookieExpiries();
  for (const name of ['token', 'litellm_session', 'session_token']) {
    const line = lines.find((l) => l.startsWith(`${name}=;`));
    assert.ok(line, `${name} is expired`);
    assert.match(line!, /Path=\/tools\/litellm\//);
    assert.match(line!, /Max-Age=0/);
  }
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../app/api/auth/logout/route.ts', import.meta.url), 'utf8');
  assert.match(src, /toolSessionCookieExpiries\(\)/, 'the logout route appends them');
});

test('hardenSessionCookie sets Secure + SameSite=Strict, HttpOnly only when asked, and never duplicates', async () => {
  const { hardenSessionCookie } = await import('@core/infra/tool-proxy');
  assert.equal(hardenSessionCookie('token=x; Path=/tools/litellm/; SameSite=Lax', false), 'token=x; Path=/tools/litellm/; Secure; SameSite=Strict');
  assert.equal(hardenSessionCookie('s=y; Path=/t/; HttpOnly', true), 's=y; Path=/t/; Secure; SameSite=Strict; HttpOnly');
});

test('short addresses: a 308 target only for an exposed, available tool and an admin; otherwise none (404)', () => {
  assert.equal(shortAddressFor('litellm', { exposed: true, role: 'admin' }), '/tools/litellm/');
  assert.equal(shortAddressFor('dagster', { exposed: true, role: 'admin' }), '/tools/dagster/');
  assert.equal(shortAddressFor('dagster', { exposed: false, role: 'admin' }), null, 'off');
  assert.equal(shortAddressFor('dagster', { exposed: true, role: 'builder' }), null, 'non-admin');
  assert.equal(shortAddressFor('langfuse', { exposed: true, role: 'admin' }), null, 'pending');
  assert.equal(shortAddressFor('trino', { exposed: true, role: 'admin' }), null, 'unknown tool');
  assert.equal(shortAddressFor('__proto__', { exposed: true, role: 'admin' }), null, 'prototype keys are not tools');
});
