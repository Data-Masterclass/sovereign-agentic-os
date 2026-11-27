/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Server messages a person reads — a stable machine `code` (+ `params`) beside the English text
 * USER STORY: As a user who picked German I want "Admin only" or "Out of scope" from the server in German, while an
 *             API or MCP client, the audit log and the server logs keep reading exactly the same English.
 * ARCHITECTURE:
 *   - The error envelope of an OS API route stays `{ error: <English> }` and GAINS `code` + optional `params`
 *     (i18n wave 4, docs/i18n/how-to.md "Server messages"). The UI renders `server.<code>` from the catalog with
 *     `params` and falls back to the English `error` (`core/i18n/server-message.ts`); every other reader is unchanged.
 *   - A code the UI may translate is DOTTED camelCase: `<area>.<thing>` (`auth.adminOnly`). Flat codes the OS
 *     already returns (`forbidden`, `not_found`, `policy_denied`, MCP's typed codes) are machine-facing and are never
 *     looked up, so a generic code can never replace a specific English sentence, and no existing client that
 *     branches on a flat code changes.
 *   - `params` carry ONLY values the English text already shows (a role, a name, a count) — a code must never reveal
 *     more than the English did. Values are strings or finite numbers; anything else is dropped.
 *   - `codedError` tags a thrown error with status + code + params. Only an error carrying the brand below is folded
 *     into the envelope by `errorResponse` / `withRoute` (`core/kernel/route-server.ts`) — a stray `e.code` (Node's
 *     `ENOENT`, a driver code) is never forwarded to the client.
 *   - Pure: no `server-only`, no Next import — the client-side reader and unit tests share these types.
 */

export type ServerParams = Record<string, string | number>;
export type ServerMessage = { code: string; params?: ServerParams };

/** `<area>.<thing>[.<more>]`, camelCase segments. Flat (legacy, machine) codes do not match. */
const CODE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** True for a code the UI may look up in the `server` catalog. */
export function isServerCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 120 && CODE.test(code);
}

/** Keep only string / finite-number params (bounded), so nothing structured or huge reaches the renderer. */
export function cleanParams(params: unknown): ServerParams | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const out: ServerParams = {};
  let n = 0;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (n >= 20 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 2000);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else continue;
    n += 1;
  }
  return n ? out : undefined;
}

const BRAND = Symbol.for('soa.serverMessage');

export type CodedError = Error & { status: number; code: string; params?: ServerParams };

function brand(e: object): void {
  Object.defineProperty(e, BRAND, { value: true, enumerable: false, configurable: true });
}

/**
 * A thrown error with an HTTP status, the unchanged English message, and the UI code (+ params):
 * `throw codedError(403, 'Admin only', 'auth.adminOnly')`.
 */
export function codedError(status: number, english: string, code: string, params?: ServerParams): CodedError {
  const err = new Error(english) as CodedError;
  err.status = status;
  return withServerCode(err, code, params);
}

/** Tag an existing error (keeps its message, status and stack) with a UI code. */
export function withServerCode<E extends Error>(err: E, code: string, params?: ServerParams): E & { code: string; params?: ServerParams } {
  const e = err as E & { code: string; params?: ServerParams };
  e.code = code;
  const p = cleanParams(params);
  if (p) e.params = p;
  brand(e);
  return e;
}

/** The `{ code, params }` an error carries for the envelope — empty unless it was tagged by this module. */
export function serverMessageOf(e: unknown): Partial<ServerMessage> {
  if (!e || typeof e !== 'object' || (e as Record<symbol, unknown>)[BRAND] !== true) return {};
  const { code, params } = e as CodedError;
  if (!isServerCode(code)) return {};
  return params ? { code, params } : { code };
}

/** The JSON body of an error response: the English text, then the code. No code ⇒ exactly `{ error }`. */
export function errorBody(english: string, code?: string, params?: ServerParams): { error: string; code?: string; params?: ServerParams } {
  if (!code) return { error: english };
  const p = cleanParams(params);
  return p ? { error: english, code, params: p } : { error: english, code };
}

/** The envelope for a caught error: `{ error: e.message }` plus the code when the error was tagged. */
export function errorBodyOf(e: unknown): { error: string; code?: string; params?: ServerParams } {
  const { code, params } = serverMessageOf(e);
  // `(e as Error).message` exactly as the routes always read it (a thrown string yields no `error`, as before).
  return errorBody((e as Error | undefined)?.message as string, code, params);
}
