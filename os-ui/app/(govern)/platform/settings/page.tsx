/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { redirect } from 'next/navigation';

/**
 * Tenant Settings moved onto the one Platform route as a tab (2026-10-30). This file
 * stays behind as a REDIRECT, not as a page: code, docs and bookmarks point at
 * /platform/settings, and removing it outright would 404 live links.
 * The body now lives in tabs/admin/ui/, rendered by /platform?section=settings.
 */
export default function SettingsRedirect(): never {
  redirect('/platform?section=settings');
}
