/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Drive the OS the way a user does: its MCP endpoint, as a named Keycloak principal
 * USER STORY: As a journey I want to act through the SAME governed path as the UI (OPA, audit,
 *             role gates), so the component records the assertions read are caused by a real
 *             user action, never by the harness writing to a component directly.
 * ARCHITECTURE:
 *   - os-ui `POST /api/mcp` (MCP over Streamable HTTP, JSON-RPC 2.0, `tools/call`), with the
 *     principal's Keycloak access token as the bearer (target identity, WP-38/WP-39).
 *   - A tool error (`isError`) is a HopError carrying the OS's typed {code, reason}.
 *   - The driver only CAUSES hops. Nothing it returns is used as proof on its own.
 */
import { baseUrl } from './endpoints.mjs';
import { request } from './http.mjs';
import { HopError } from './hop.mjs';
import { tokenFor } from './records/keycloak.mjs';

let rpcId = 0;

function parseRpc(res) {
  if (typeof res.data === 'object') return res.data;
  const line = res.text.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5)) : JSON.parse(res.text);
}

export async function callTool(principal, name, args = {}) {
  const token = await tokenFor(principal);
  const res = await request('os-ui', `mcp ${name} as ${principal}`, `${await baseUrl('osUi')}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    timeoutMs: 120000,
  });
  const rpc = parseRpc(res);
  if (rpc.error) throw new HopError({ component: 'os-ui', hop: `mcp ${name}`, reason: `${rpc.error.code}: ${rpc.error.message}` });
  const text = rpc.result?.content?.map((c) => c.text ?? '').join('') ?? '';
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  if (rpc.result?.isError) {
    const code = payload?.code ?? 'tool_error';
    throw new HopError({ component: 'os-ui', hop: `mcp ${name}`, reason: `${code}: ${payload?.reason ?? text}`, detail: payload });
  }
  return payload;
}

/** Upload a file through the Files tab's route, as the principal (multipart, like the browser). */
export async function uploadFile(principal, { name, bytes, folder = '' }) {
  const token = await tokenFor(principal);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'application/pdf' }), name);
  if (folder) form.set('folder', folder);
  let res;
  try {
    res = await fetch(`${await baseUrl('osUi')}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(120000) });
  } catch (err) {
    throw new HopError({ component: 'os-ui', hop: 'POST /api/files', reason: `unreachable: ${err.message}` });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HopError({ component: 'os-ui', hop: 'POST /api/files', reason: `HTTP ${res.status} ${body.code ?? ''} ${body.reason ?? ''}`.trim() });
  return body;
}
