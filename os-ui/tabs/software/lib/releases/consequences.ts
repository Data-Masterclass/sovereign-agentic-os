/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - what going live in Prod starts, in the release's own words (the confirm dialog)
 * USER STORY: As the person going live I want the confirm dialog to say which release, digest and pending
 *             migrations will run in Prod before I confirm.
 * ARCHITECTURE:
 *   - EXTENSION POINT created by W0, owned by workstream C2. The app lifecycle adapter's `consequences`
 *     (lifecycle-adapter.ts, owner F) calls `releaseConsequences(app)` ONLY while the App Builder flag is on; with it
 *     off the adapter has no consequences, exactly as before.
 *   - The W0 stub returns no sentences for any app.
 */
import type { App } from '@tabs/software/lib/apps';

export async function releaseConsequences(app: App): Promise<string[]> {
  void app;
  return [];
}
