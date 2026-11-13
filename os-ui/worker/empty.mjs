/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint
 * FEATURE:    The empty module `server-only` / `client-only` resolve to in the worker process
 * USER STORY: As the worker process I import the SAME modules the Next build compiles, several of
 *             which assert `import 'server-only'` — a bundler-only marker package. Resolving it to
 *             this file lets those modules load in a plain Node process without weakening the
 *             assertion anywhere a bundler is involved.
 * ARCHITECTURE: Exports nothing. `worker/resolve-hook.mjs` short-circuits both specifiers here.
 */
export {};
