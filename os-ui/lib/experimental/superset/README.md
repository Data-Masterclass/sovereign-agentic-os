<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Superset

A **thin adapter** for importing Apache Superset dashboards from within the Sovereign
OS. It converts the OS dashboard YAML manifest into a Superset-compatible export ZIP
and POSTs it to Superset via CSRF-token + trusted-proxy SSO — no user credentials
transit this module. The adapter is server-only; the caller is always
`lib/dashboards/delivery.ts`.

## Golden path

1. **Manifest** — `lib/dashboards` builds a YAML manifest describing charts, datasets
   and layout for a governed dashboard.
2. **Build ZIP** — `buildImportZip(manifest)` in `import-bundle.ts` converts the
   manifest into an in-memory `dashboard_export.zip` (pure, no I/O) via `zip.ts`.
3. **Auth** — `csrf()` in `auth.ts` fetches a CSRF token from Superset's session
   endpoint using the `SUPERSET_SERVICE_USER` service account. `serviceHeaders()`
   assembles the required headers including `X-CSRFToken` and the session cookie.
4. **Import** — `importDashboardBundle(base, bundle)` in `client.ts` POSTs the ZIP
   to `/api/v1/dashboard/import/` with the trusted-proxy `X-Forwarded-User` header.
   Superset's `AUTH_REMOTE_USER` mode admits the request without a password check.
5. **Delete** — `deleteDashboard(base, id)` in `client.ts` removes a previously
   imported dashboard by its Superset ID.

## Public API

- **`client.ts`** — `importDashboardBundle(base, bundle)`, `deleteDashboard(base, id)`.
  Server-only entry point; called exclusively from `lib/dashboards/delivery.ts`.
- **`import-bundle.ts`** — `buildImportZip(manifest)`: pure manifest-to-ZIP
  conversion; no network I/O, safe to unit-test in isolation.
- **`zip.ts`** — `assembleZip(files)`: in-memory ZIP builder utility; pure.
- **`auth.ts`** — `csrf()`, `serviceHeaders()`, `serviceUser()`, `withTimeout()`:
  session + CSRF helpers. Reads `SUPERSET_SERVICE_USER` (default `admin`) from env.

## Invariants & Dependencies

**Invariants**

- **Server-only.** No file in this module may be imported by a client component or
  edge runtime; all network calls target the Superset internal URL.
- **Trusted-proxy SSO only.** Auth uses `X-Forwarded-User` + session cookie; the
  service account is the sole credential — no user passwords or API keys are handled.
- **One credential.** `SUPERSET_SERVICE_USER` (env var, default `admin`) is the only
  secret; it is a username, not a token, and never written to logs or responses.
- **Pure ZIP builder.** `buildImportZip` and `assembleZip` are side-effect-free;
  they may be called in tests without any network stub.
- **Caller owns orchestration.** This module imports nothing from `lib/dashboards`;
  the dependency arrow runs one way: `lib/dashboards/delivery.ts` → `lib/superset`.

**Dependencies**

- `lib/core/config` — `supersetInternalUrl` (base URL for all Superset API calls).
- Node.js built-ins only (`Buffer`, streams) — no third-party HTTP client.
