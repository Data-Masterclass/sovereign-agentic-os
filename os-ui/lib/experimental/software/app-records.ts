/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { runnerStatus, runnerName } from './runner.ts';
import { getSnapshot } from './file-mirror.ts';
import { templateFiles } from './apps.ts';
import { resolveToolOperation, fillPathParams, seedToolResult } from './tool-exec.ts';
import {
  addAppRecord,
  listAppRecords,
  getAppRecord,
  exportAppRecords,
  type RecordActor,
} from './app-records-store.ts';
export type { RecordActor };
import { config } from '@/lib/core/config';
import type { App } from './apps.ts';

/**
 * ONE STORE, TWO DOORS — the app's OWN records.
 *
 * An OS-built app's internal writes must NOT create OS datasets (the governed data
 * plane is read-only and the app identity lacks those perms). The write door is
 * `os.records.*` (list/add/get/export), and its durable home is the OS-side
 * app-records store (lib/software/app-records-store.ts) — because the DEFAULT app
 * template is a static SPA with NO backend of its own. The four record tools are
 * therefore backed by that store (`source:'os-records-store'`), scoped to the caller.
 *
 * The platform reaches records two ways onto the SAME store: an AGENT calls the app's
 * MCP tools through `app/api/apps/[id]/tool/route.ts`, and the app's own frontend calls
 * the by-slug records routes + the `os.records.*` SDK. Both funnel through the shared
 * executor here (`executeAppTool`) + the shared envelope-write gate.
 *
 * NON-record app tools keep the original behaviour: proxy to the app's live in-cluster
 * Service when its runner pod is running (`source:'live-app'`), else honestly-labelled
 * demo seed (`source:'demo-seed'`).
 */

/** The four record operations, by the app's committed `/records` OpenAPI convention. */
export const RECORD_TOOLS = {
  list: 'list_records',
  add: 'add_record',
  get: 'get_record',
  export: 'export_records',
} as const;

export type RecordToolName = (typeof RECORD_TOOLS)[keyof typeof RECORD_TOOLS];

/**
 * The caller identity a record tool is scoped to. The `domain` is the user's EFFECTIVE
 * operating domain — the chosen active domain, or their sole domain when they belong to
 * exactly one (else null). This is the SAME accessor `app/api/auth/me/route.ts` uses, so
 * the record store's Domain scope tracks the OS-wide domain switcher: a record shows up
 * as "Domain" only while the caller is operating in the app's owning domain.
 */
export function recordActor(user: {
  id: string;
  activeDomain: string | null;
  domains: string[];
}): RecordActor {
  return { id: user.id, domain: user.activeDomain ?? (user.domains.length === 1 ? user.domains[0] : '') };
}

/** Which record tools WRITE (governed by the approved deploy envelope). Reads are always-on. */
const WRITE_TOOLS = new Set<RecordToolName>([RECORD_TOOLS.add, RECORD_TOOLS.export]);

/**
 * Does the gate permit this record tool to run live? Reads are always-on.
 *
 * WRITES to the app's OWN records (`add_record`/`export_records`) are AUTO-APPROVED
 * BY DEFAULT — the owner's rule: "the app's own write data must have automatic
 * read+write out of the box." Every tool that reaches this gate is one of the four
 * fixed `os.records.*` tools (its OWN store), so allowing its writes never widens
 * access to any dataset/knowledge/file/connection — only the app's own records. It
 * stays REVOCABLE: an owner who flips `app.recordWritesRevoked` turns the default
 * off, and from then on the write runs live only if a Builder has explicitly listed
 * it in the approved deploy envelope (the pre-0.6.97 behaviour). We deliberately do
 * NOT auto-approve any non-record / external write capability here — this gate is
 * only ever asked about `os.records.*`.
 */
export function envelopeAllowsRecordTool(
  app: App,
  tool: RecordToolName,
): { ok: true } | { ok: false; reason: string } {
  if (!WRITE_TOOLS.has(tool)) return { ok: true }; // reads are always-on

  // Default-ON: the app's own record writes work out of the box, revocably.
  if (app.recordWritesRevoked !== true) return { ok: true };

  // Revoked: fall back to the explicit Builder-approved envelope (legacy gate).
  const approved = app.deploy.approved?.writeTools ?? [];
  if (approved.includes(tool)) return { ok: true };
  return {
    ok: false,
    reason:
      `'${tool}' is REVOKED for this app's own records and is not in its approved deploy ` +
      `envelope. Re-enable the app's records write access (un-revoke it), or request a deploy ` +
      `(request_deploy) and have a Builder approve the review card that lists this write tool. ` +
      `Reads work now; this write is held until then.`,
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

/** The four record tool names, for O(1) "is this a record tool?" checks. */
const RECORD_TOOL_NAMES = new Set<string>(Object.values(RECORD_TOOLS));

/**
 * Run one of the four record tools against the durable OS-side app-records store,
 * scoped to `actor` (My + Domain). Writes stamp owner = actor.id and domain =
 * the APP's owning domain (`app.domain`). Every result is labelled
 * `source:'os-records-store'` — honest: the OS's own governed store answered, not a
 * live app pod and not demo seed.
 */
async function executeRecordTool(
  app: App,
  tool: string,
  args: Record<string, unknown>,
  actor: RecordActor,
): Promise<Record<string, unknown>> {
  const label = { source: 'os-records-store' as const };
  if (tool === RECORD_TOOLS.add) {
    const r = await addAppRecord({ appSlug: app.slug, owner: actor.id, domain: app.domain, record: args });
    return { ...label, added: { id: r.id, ...r.record } };
  }
  if (tool === RECORD_TOOLS.get) {
    const r = await getAppRecord({ appSlug: app.slug, id: String(args.id ?? ''), actor });
    return { ...label, item: r ? { id: r.id, ...r.record } : null };
  }
  if (tool === RECORD_TOOLS.export) {
    const rows = await exportAppRecords({ appSlug: app.slug, actor });
    return { ...label, file: `${app.slug}-records.json`, rows: rows.length, items: rows.map((r) => ({ id: r.id, ...r.record })) };
  }
  // list_records
  const rows = await listAppRecords({ appSlug: app.slug, actor });
  return { ...label, items: rows.map((r) => ({ id: r.id, ...r.record })) };
}

/**
 * Execute an app tool. RECORD tools (list/add/get/export) are backed by the durable
 * OS-side app-records store (`source:'os-records-store'`), scoped to the caller — the
 * store is required because the default app template is a static SPA with no backend.
 * NON-record tools keep the original behaviour: when the app's runner pod is RUNNING,
 * proxy to the app's real in-cluster Service per its committed OpenAPI
 * (`source:'live-app'`); otherwise deterministic, honestly-labelled seed data
 * (`source:'demo-seed'`) so the flow stays demonstrable.
 *
 * This is the shared core the `[id]/tool` route (any app tool) and the by-slug
 * records routes (the four record tools) both call — one store, two doors. It
 * performs NO authorization itself; each door runs its own gate first (the tool
 * route's OPA/profile check; the records routes' entry + envelope-write gate). The
 * optional `actor` is REQUIRED for record tools (both record doors thread it in); if a
 * record tool is reached without one, it falls back to the honest demo seed rather
 * than leaking across the caller's scope.
 */
export async function executeAppTool(
  app: App,
  tool: string,
  args: Record<string, unknown> = {},
  actor?: RecordActor,
): Promise<Record<string, unknown>> {
  if (RECORD_TOOL_NAMES.has(tool) && actor) {
    return executeRecordTool(app, tool, args, actor);
  }
  let result: Record<string, unknown> | null = null;
  const status = await runnerStatus({ slug: app.slug });
  if (status.live && status.phase === 'running') {
    const files = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
    const op = resolveToolOperation(files, tool);
    if (op) result = await callLiveApp(app.slug, op, args);
  }
  return result ?? seedToolResult(tool, args);
}
