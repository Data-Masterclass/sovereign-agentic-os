/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - which builder an app opens in
 * USER STORY: As the owner I want only `nextjs-web@2` apps, and only while the App Builder switch is on, to open in the
 *             new three-view shell; every other app keeps today's builder.
 * ARCHITECTURE: PURE, client-safe. `appBuilder` is the flag as the server sent it (GET /api/apps/[id] adds
 *             `appBuilder: true` only when it is on). Used by SoftwareBuilder.tsx; unit-tested in app-builder-w0.test.ts.
 */

export function usesAppBuilder(app: { templateVersion?: 1 | 2 }, appBuilder: boolean | undefined): boolean {
  return appBuilder === true && app.templateVersion === 2;
}
