/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Typed errors for the OS client. Every governed OS route answers a failure as
 * `{ error: string }` with an HTTP status (see `lib/data/server.ts` errorResponse
 * and its siblings). The client maps those honestly — it NEVER swallows a refusal
 * into a fake success:
 *   401 → NotAuthenticated  (no/expired OS session cookie)
 *   403 → Forbidden         (OPA / row-and-document-level-security refusal; carries
 *                            the server's reason verbatim so the app can show WHY)
 *   other non-2xx → OsError (the raw status + server reason)
 * A truly unsupported-on-purpose call (e.g. raw client SQL, which the OS never
 * accepts) throws UnsupportedQuery locally — before any request — so the app is
 * told the truth rather than handed a misleading 4xx.
 */

/** Base class for every error the SDK raises. */
export class OsError extends Error {
  /** HTTP status when the error came from a route (0 for client-side errors). */
  readonly status: number;
  /** The route that was called, when known — for diagnostics. */
  readonly url?: string;
  constructor(message: string, status: number, url?: string) {
    super(message);
    this.name = 'OsError';
    this.status = status;
    this.url = url;
  }
}

/** 401 — the OS session cookie is missing or expired. Sign in again. */
export class NotAuthenticated extends OsError {
  constructor(message = 'Not authenticated: no valid Sovereign OS session', url?: string) {
    super(message, 401, url);
    this.name = 'NotAuthenticated';
  }
}

/**
 * 403 — the governed call was refused by policy (OPA) or filtered out by
 * row/document-level security. `reason` is the server's own explanation, surfaced
 * unchanged so the app can be honest about the denial instead of guessing.
 */
export class Forbidden extends OsError {
  readonly reason: string;
  constructor(reason: string, url?: string) {
    super(`Forbidden: ${reason}`, 403, url);
    this.name = 'Forbidden';
    this.reason = reason;
  }
}

/**
 * A call the Sovereign OS deliberately does not expose over a governed route
 * (thrown locally, no request made). The prime example is raw client-supplied
 * SQL: the OS recompiles SQL server-side from validated ops and never trusts a
 * SQL string from a caller, so the SDK refuses it up front rather than pretend.
 */
export class UnsupportedQuery extends OsError {
  constructor(message: string) {
    super(message, 0);
    this.name = 'UnsupportedQuery';
  }
}
