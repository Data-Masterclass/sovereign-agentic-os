/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint
 * FEATURE:    The `os-governance-migrate` Job's command
 * USER STORY: As the chart I want ONE command — `node --experimental-strip-types worker/migrate-governance.mjs`
 *             — whose exit code tells Helm whether the governance schema is installed.
 * ARCHITECTURE: registers `worker/resolve-hook.mjs` (the tsconfig path aliases), imports
 *             `worker/migrate-governance.ts` under Node's type stripping and runs `main()`. A failure
 *             prints the reason to stderr and exits 1 (the Job fails; there is no continue-anyway).
 */
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);

try {
  const { main } = await import('./migrate-governance.ts');
  const ran = await main();
  console.log(ran.length ? `os-governance-migrate: applied ${ran.length} migration(s): ${ran.join(', ')}` : 'os-governance-migrate: up to date (0 migrations)');
  process.exit(0);
} catch (err) {
  console.error(`os-governance-migrate: FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
