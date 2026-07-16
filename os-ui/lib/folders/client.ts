/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { renameLeafPath } from '../core/folders.ts';
import type { FolderRef } from '@/components/core/FolderTree';

/** Re-exported so tabs import both folder-client helpers from one place. The pure
 *  path maths lives in `lib/core/folders` (unit-tested there). */
export const renamedPath = renameLeafPath;

/**
 * Tiny browser-side helpers the foldered tabs (Files, Data, Knowledge, Metrics)
 * share for the folder ••• lifecycle. Kept out of the store (which is server-side,
 * governed) — these only speak to the governed `/api/folders` routes AS the user.
 *
 * The key one is `ensureFolderId`: the rail shows a UNION of real registry folders
 * AND SYNTHETIC folders derived from member-item paths (a folder a user created only
 * by moving files into a path). A synthetic folder has no registry row → no `id` →
 * the lifecycle route (`/api/folders/:id`) has nothing to act on, so Archive/Rename
 * would dead-end. `ensureFolderId` MATERIALISES the row on demand (idempotent POST —
 * the store returns the existing row if one already exists) so ANY folder the user
 * sees can be archived or renamed. Materialisation is itself edit-scoped in the store.
 */

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
    throw new Error(body.error ?? 'Could not create folder');
  }
  const { folder } = (await res.json()) as { folder: { id: string } };
  return folder.id;
}
