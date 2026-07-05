/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLS,
  resolveTool,
  roleAllowed,
  rewriteCsp,
  rewriteLocation,
  rewriteSetCookie,
  buildUpstreamHeaders,
  transformResponseHeaders,
  proxy,
  type Tool,
} from './tool-proxy.ts';

const USER = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'builder' as const };

function fakeTool(over: Partial<Tool>): Tool {
  return {
    key: 'x',
    title: 'X',
    upstream: 'http://x:9000',
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/x',
    minRole: 'creator',
    embeddable: true,
    sso: { mode: 'none' },
    ...over,
  };
}

/* ------------------------------------------------------------- registry + gate */

test('registry keys are self-consistent (key + basePath)', () => {
  for (const [key, t] of Object.entries(TOOLS)) {
    assert.equal(t.key, key);
    assert.equal(t.basePath, `/tools/${key}`);
    assert.ok(t.upstream.startsWith('http'), `${key} upstream is an http URL`);
  }
  assert.ok(TOOLS.mlflow, 'mlflow (pilot) is registered');
  assert.equal(resolveTool('mlflow')?.key, 'mlflow');
  assert.equal(resolveTool('does-not-exist'), undefined);
});

test('role gate: minRole is enforced by rank, not equality', () => {
  // participant < creator < builder < admin
  assert.equal(roleAllowed('creator', 'creator'), true);
  assert.equal(roleAllowed('admin', 'builder'), true); // higher role passes a lower bar
  assert.equal(roleAllowed('creator', 'builder'), false); // lower role blocked
  assert.equal(roleAllowed('builder', 'builder'), true);
  // A builder-gated tool (OpenSearch) denies a creator but allows a builder.
  assert.equal(roleAllowed('creator', TOOLS.opensearch.minRole), false);
  assert.equal(roleAllowed('builder', TOOLS.opensearch.minRole), true);
  // Featureform is a Science-tab launcher; a creator must be able to open it,
  // consistent with MLflow (both creator+). Regression guard for the role gate.
  assert.equal(TOOLS.featureform.minRole, 'creator');
  assert.equal(TOOLS.mlflow.minRole, 'creator');
  assert.equal(roleAllowed('creator', TOOLS.featureform.minRole), true);
});

/* --------------------------------------------------------------- CSP / frame */

test('rewriteCsp strips any existing frame-ancestors and pins it to self', () => {
  const out = rewriteCsp("default-src 'self'; frame-ancestors https://evil.example; script-src 'self'");
  assert.ok(!/https:\/\/evil\.example/.test(out), 'upstream frame-ancestors removed');
  assert.equal((out.match(/frame-ancestors/g) ?? []).length, 1, 'exactly one frame-ancestors');
  assert.ok(/frame-ancestors 'self'/.test(out));
  assert.ok(/default-src 'self'/.test(out), 'other directives preserved');
});

test('rewriteCsp adds frame-ancestors self even when none was present', () => {
  assert.ok(/frame-ancestors 'self'/.test(rewriteCsp("default-src 'self'")));
});

test('transformResponseHeaders removes X-Frame-Options and rewrites CSP', () => {
  const upstream = new Headers();
  upstream.set('x-frame-options', 'DENY');
  upstream.set('content-security-policy', "frame-ancestors 'none'");
  upstream.set('content-type', 'text/html');
  const out = transformResponseHeaders({
    headers: upstream,
    tool: fakeTool({}),
    upstreamOrigin: 'http://x:9000',
    proto: 'https',
    host: 'os.agentic.datamasterclass.com',
  });
  assert.equal(out.get('x-frame-options'), null, 'x-frame-options dropped');
  assert.ok(/frame-ancestors 'self'/.test(out.get('content-security-policy') ?? ''));
  assert.ok(!/'none'/.test(out.get('content-security-policy') ?? ''));
  assert.equal(out.get('content-type'), 'text/html', 'unrelated headers preserved');
});

/* ------------------------------------------------------------ location cookie */

test('rewriteLocation prefixes absolute-upstream and root-relative redirects', () => {
  const bp = '/tools/mlflow';
  const origin = 'http://mlflow:5000';
  assert.equal(rewriteLocation('http://mlflow:5000/#/experiments', origin, bp), '/tools/mlflow/#/experiments');
  assert.equal(rewriteLocation('/ajax-api/2.0/mlflow/runs', origin, bp), '/tools/mlflow/ajax-api/2.0/mlflow/runs');
  // already-prefixed is left alone (no double prefix)
  assert.equal(rewriteLocation('/tools/mlflow/foo', origin, bp), '/tools/mlflow/foo');
  // an external redirect is untouched
  assert.equal(rewriteLocation('https://accounts.google.com/o', origin, bp), 'https://accounts.google.com/o');
});

test('rewriteSetCookie moves Path into the tool prefix and drops Domain', () => {
  assert.equal(
    rewriteSetCookie('session=abc; Path=/; HttpOnly; Secure', '/tools/forgejo'),
    'session=abc; Path=/tools/forgejo/; HttpOnly; Secure',
  );
  assert.equal(
    rewriteSetCookie('csrf=z; Path=/api; SameSite=Lax', '/tools/superset'),
    'csrf=z; Path=/tools/superset/api; SameSite=Lax',
  );
  // Domain is stripped so the cookie stays host-only on the OS origin.
  assert.ok(!/Domain=/i.test(rewriteSetCookie('a=b; Path=/; Domain=mlflow', '/tools/mlflow')));
  // no Path present → one is added scoped to the tool
  assert.ok(/Path=\/tools\/x\//.test(rewriteSetCookie('a=b; HttpOnly', '/tools/x')));
});

/* ------------------------------------------------------------ SSO injection */

test('header SSO injects identity + mapped role, plus the forwarded chain', () => {
  const tool = fakeTool({
    key: 'superset',
    basePath: '/tools/superset',
    sso: {
      mode: 'header',
      roleMap: { admin: 'Admin', builder: 'Alpha', 'creator': 'Gamma' },
    },
  });
  const h = buildUpstreamHeaders({
    tool,
    user: USER,
    incoming: new Headers({ cookie: 'soa_session=deadbeef; superset_session=keep' }),
    proto: 'https',
    host: 'os.agentic.datamasterclass.com',
  });
  assert.equal(h.get('x-forwarded-user'), 'alice');
  assert.equal(h.get('x-forwarded-preferred-username'), 'alice');
  assert.equal(h.get('x-forwarded-roles'), 'Alpha'); // builder → Alpha
  assert.equal(h.get('x-forwarded-proto'), 'https');
  assert.equal(h.get('x-forwarded-prefix'), '/tools/superset');
  assert.equal(h.get('x-forwarded-host'), 'os.agentic.datamasterclass.com');
  // the OS session cookie is NOT forwarded upstream; the tool's own cookie is.
  assert.ok(!/soa_session/.test(h.get('cookie') ?? ''));
  assert.ok(/superset_session=keep/.test(h.get('cookie') ?? ''));
  assert.equal(h.get('host'), null, 'inbound Host is dropped');
});

test('header SSO honours a tool-specific user header alias (Forgejo)', () => {
  const tool = fakeTool({ key: 'forgejo', sso: { mode: 'header', userHeader: 'X-WEBAUTH-USER' } });
  const h = buildUpstreamHeaders({
    tool,
    user: USER,
    incoming: new Headers(),
    proto: 'https',
    host: 'os',
  });
  assert.equal(h.get('x-webauth-user'), 'alice');
  assert.equal(h.get('x-forwarded-user'), 'alice'); // canonical also set
});

test('basic SSO injects a server-side credential and NO identity headers', () => {
  const tool = fakeTool({ sso: { mode: 'basic', basic: { user: 'svc', pass: 's3cret' } } });
  const h = buildUpstreamHeaders({ tool, user: USER, incoming: new Headers(), proto: 'https', host: 'os' });
  assert.equal(h.get('authorization'), 'Basic ' + Buffer.from('svc:s3cret').toString('base64'));
  assert.equal(h.get('x-forwarded-user'), null, 'no per-user identity leaked in basic mode');
});

test('none SSO injects neither credentials nor identity, only the forwarded chain', () => {
  const tool = fakeTool({ sso: { mode: 'none' } });
  const h = buildUpstreamHeaders({ tool, user: USER, incoming: new Headers(), proto: 'https', host: 'os' });
  assert.equal(h.get('authorization'), null);
  assert.equal(h.get('x-forwarded-user'), null);
  assert.equal(h.get('x-forwarded-prefix'), '/tools/x');
});

/* ------------------------------------------------------------ proxy() e2e */

test('proxy() streams the upstream body and applies every header transform', async () => {
  const tool = fakeTool({ key: 'mlflow', basePath: '/tools/mlflow', upstream: 'http://mlflow:5000' });
  let sawUrl = '';
  let sawUserHeader: string | null = 'unset';
  const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    sawUrl = String(url);
    sawUserHeader = new Headers(init?.headers).get('x-forwarded-user');
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('<html>ok</html>'));
        c.close();
      },
    });
    return new Response(body, {
      status: 302,
      headers: {
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "frame-ancestors 'none'",
        location: 'http://mlflow:5000/#/experiments/1',
      },
    });
  };

  const req = new Request('https://os.agentic.datamasterclass.com/tools/mlflow/ajax-api/x?a=1', {
    headers: { host: 'os.agentic.datamasterclass.com', 'x-forwarded-proto': 'https' },
  });
  const res = await proxy(req, tool, ['ajax-api', 'x'], USER, fakeFetch as typeof fetch);

  assert.equal(sawUrl, 'http://mlflow:5000/ajax-api/x?a=1', 'path + query forwarded to upstream');
  assert.equal(sawUserHeader, null, 'mlflow is sso.none — no identity header');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.ok(/frame-ancestors 'self'/.test(res.headers.get('content-security-policy') ?? ''));
  assert.equal(res.headers.get('location'), '/tools/mlflow/#/experiments/1');
  assert.equal(await res.text(), '<html>ok</html>', 'body streamed through unbuffered');
});
