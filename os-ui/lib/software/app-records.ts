/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { runnerStatus, runnerName } from './runner.ts';
import { getSnapshot } from './file-mirror.ts';
import { templateFiles } from './apps.ts';
import { resolveToolOperation, fillPathParams, seedToolResult } from './tool-exec.ts';
import { config } from '@/lib/core/config';
import type { App } from './apps.ts';

/**
 * ONE STORE, TWO DOORS — the app's OWN records.
 *
 * An app's records live in the app's OWN backend (its committed OpenAPI `/records`
 * endpoints served by its in-cluster Service), NOT in an OS-side store. The
 * platform already reaches them one way: an AGENT calls the app's MCP tools
 * (`list_records` / `add_record` / `get_record` / `export_records`) through
 * `app/api/apps/[id]/tool/route.ts`, which authorizes then PROXIES to the live app
 * (or returns honestly-labelled seed data when the runner is not live).
 *
 * This module factors out that EXACT execution so a SECOND door — the app's own
 * frontend, via the by-slug records routes + the `os.records.*` SDK — runs the
 * same governed record semantics against the same store. No new store, no new
 * governance: a shared executor + a shared envelope-write gate.
 */

/** The four record operations, by the app's committed `/records` OpenAPI convention. */
export const RECORD_TOOLS = {
  list: 'list_records',
  add: 'add_record',
  get: 'get_record',
  export: 'export_records',
} as const;

export type RecordToolName = (typeof RECORD_TOOLS)[keyof typeof RECORD_TOOLS];

/** Which record tools WRITE (governed by the approved deploy envelope). Reads are always-on. */
const WRITE_TOOLS = new Set<RecordToolName>([RECORD_TOOLS.add, RECORD_TOOLS.export]);

/**
 * Does the app's Builder-APPROVED deploy envelope permit this write tool to run
 * live? Reads are always allowed. A write tool that a Builder has not signed off on
 * (absent from `deploy.approved.writeTools`, or an app with no approved envelope at
 * all) is DENIED — the honest reason names the governance path so the caller knows
 * exactly how to enable it, instead of a silent nothing.
 */
export function envelopeAllowsRecordTool(
  app: App,
  tool: RecordToolName,
): { ok: true } | { ok: false; reason: string } {
  if (!WRITE_TOOLS.has(tool)) return { ok: true }; // reads are always-on
  const approved = app.deploy.approved?.writeTools ?? [];
  if (approved.includes(tool)) return { ok: true };
  return {
    ok: false,
    reason:
      `'${tool}' is not in this app's approved deploy envelope. Writes run live only after a ` +
      `Builder approves them: request a deploy (request_deploy) and have a Builder approve the ` +
      `review card that lists this write tool. Reads work now; this write is held until then.`,
  };
}

/** Proxy a record tool to the app's REAL in-cluster Service per its committed OpenAPI. */
async function callLiveApp(
  slug: string,
  op: { method: string; path: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const path = fillPathParams(op.path, args);
  const base = `http://${runnerName(slug)}.${config.softwareRunnerNamespace}`;
  const isGet = op.method === 'GET' || op.method === 'HEAD';
  const query =
    isGet && Object.keys(args).length > 0
      ? '?' + new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()
      : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}${path}${query}`, {
      method: op.method,
      headers: { accept: 'application/json', ...(isGet ? {} : { 'content-type': 'application/json' }) },
      body: isGet ? undefined : JSON.stringify(args),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw.slice(0, 2000);
    }
    return { source: 'live-app', endpoint: `${op.method} ${path}`, status: res.status, body };
  } catch {
    return null; // service unreachable despite a running pod → honest demo fallback
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute an app tool the SAME way the MCP tool route does: when the app's runner
 * pod is actually RUNNING, proxy the call to the app's real in-cluster Service per
 * its committed OpenAPI (`source:'live-app'`); otherwise return deterministic,
 * honestly-labelled seed data (`source:'demo-seed'`) so the flow stays demonstrable
 * without ever pretending the deployed app answered.
 *
 * This is the shared core the `[id]/tool` route (any app tool) and the by-slug
 * records routes (the four record tools) both call — one store, two doors. It
 * performs NO authorization itself; each door runs its own gate first (the tool
 * route's OPA/profile check; the records routes' entry + envelope-write gate).
 */
export async function executeAppTool(
  app: App,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> | null = null;
  const status = await runnerStatus({ slug: app.slug });
  if (status.live && status.phase === 'running') {
    const files = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
    const op = resolveToolOperation(files, tool);
    if (op) result = await callLiveApp(app.slug, op, args);
  }
  return result ?? seedToolResult(tool, args);
}
