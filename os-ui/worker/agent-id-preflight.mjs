/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui entrypoint
 * FEATURE:    WP-53b N3 — the read-only agent id preflight, as a command of the runtime image
 * USER STORY: As the operator I run, in the os-ui-worker pod, ONE command before switching
 *             AGENT_GRAPH_MODULE on: `node --experimental-strip-types src/worker/agent-id-preflight.mjs`
 *             (from /app), and require exit 0.
 * ARCHITECTURE: registers `worker/resolve-hook.mjs` like `worker/start.mjs`, then runs
 *             `tabs/agents/lib/module/preflight-run.ts` `main()` and exits with its code
 *             (0 pass, 1 refused, 2 could not check). Flags: --repos-only, --propose, --json.
 */
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);

const { main } = await import('../tabs/agents/lib/module/preflight-run.ts');
try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  console.error(`agent-id-preflight: FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(2);
}
