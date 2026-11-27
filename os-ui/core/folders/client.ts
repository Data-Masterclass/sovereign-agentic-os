/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Folder client helpers — browser-side helpers for the folder ••• menu
 * USER STORY: As a user I want to archive or rename any folder I can see in the rail, even one
 *             that only exists because I moved items into a path, so that folder actions never dead-end.
 * ARCHITECTURE:
 *   - Client-only; calls the governed `/api/folders` routes as the signed-in user. Used by the
 *     foldered tab browsers (Files, Data, Metrics, Dashboards, Agents, Connections, Software, …).
 *   - `ensureFolderId` creates the registry row for a synthetic folder on demand (idempotent POST;
 *     the store returns an existing row). The store applies the edit-scope check.
 *   - `renamedPath` re-exports the pure path helper from `@core/kernel/folders`.
 */
'use client';

import { renameLeafPath } from '@core/kernel/folders';
import type { FolderRef } from '@core/ui/core/FolderTree';

/** Re-exported so tabs import both folder-client helpers from one place. The pure
 *  path maths lives in `lib/core/folders` (unit-tested there). */
export const renamedPath = renameLeafPath;

/** Materialise (if needed) the registry row for `ref` and return its id. Idempotent:
 *  a folder that already has a row just returns `ref.id`. Throws with the API error. */
export async function ensureFolderId(tab: string, ref: FolderRef): Promise<string> {
  if (ref.id) return ref.id;
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tab, scope: ref.scope, path: ref.path }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // `body` rides along so a component can render it in the person's language (`useServerMessage`).
    throw Object.assign(new Error(body.error ?? 'Could not create folder'), { body });
  }
  const { folder } = (await res.json()) as { folder: { id: string } };
  return folder.id;
}
