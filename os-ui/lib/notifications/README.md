<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Notifications

`lib/notifications/` is the in-app notification inbox — a principal-scoped fallback delivery
channel for reports and alert firings when no external mailer is configured. It uses the same
dual-store pattern as `lib/marketplace/store.ts`: a globalThis-pinned in-process Map for
sub-millisecond reads, with write-through to an OpenSearch index for durability across pod
restarts.

## Public API

### `store.ts` (server-only)

The single file in this module. All exports are server-side.

- **`NotificationKind`** — `'report' | 'alert'`
- **`OsNotification`** — the record shape: `{ id, userId, kind, title, body, createdAt }`
- **`ensureHydrated()`** — lazy-loads the in-process store from the `os-notifications`
  OpenSearch index on first call. Called automatically by `addNotification` and
  `listNotifications`; exposed for health-check routes.
- **`addNotification({ userId, kind, title, body })`** — creates an `OsNotification`,
  writes it to the in-process Map, and upserts to `os-notifications`. Returns the new
  record. Called by `lib/metrics/alerts.ts` (alert firings) and the dashboard delivery
  path (scheduled report delivery).
- **`listNotifications(userId)`** — returns all notifications for the given user,
  newest-first. Hydrates on first call. Called from `app/api/notifications/route.ts`.
- **`__resetNotifications()`** — test-only: clears the in-process store without touching
  OpenSearch.

Consumed by `app/api/notifications/route.ts`, `lib/metrics/alerts.ts`, and the dashboard
report-delivery path.

## Dependencies

- **`lib/infra/os-mirror`** — `osMirror` client for OpenSearch index reads and upserts
  (`os-notifications` index).
- No dependency on `lib/infra/mailer` — this module is explicitly the non-mailer path.

## Invariants

- **Honest fallback, not the primary channel.** When a mailer IS configured, delivery
  goes through `lib/infra/mailer` AND a notification is stored here as a record. When
  no mailer is configured, this inbox is the only delivery.
- **Principal-scoped reads.** `listNotifications(userId)` returns only that user's
  records; the route layer enforces that `userId` matches the session user.
- **Dual-store consistency.** Every `addNotification` write hits both the in-process
  Map and OpenSearch before returning. A pod restart re-hydrates from OpenSearch; no
  notifications are lost across restarts.
