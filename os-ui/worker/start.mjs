/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint
 * FEATURE:    The `os-ui-worker` container command
 * USER STORY: As the chart I want ONE command — `node --experimental-strip-types worker/start.mjs`
 *             — that boots the agent-run worker from the same image as os-ui, and whose exit code
 *             tells Kubernetes the truth.
 * ARCHITECTURE: registers `worker/resolve-hook.mjs` (the tsconfig path aliases), then imports
 *             `worker/agent-runs.ts` under Node's type stripping (Node >= 22.6) and runs `main()`.
 *             A boot failure exits non-zero so the pod crash-loops instead of idling silently.
 */
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);

const { main } = await import('./agent-runs.ts');
try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`[agent-runs-worker] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
