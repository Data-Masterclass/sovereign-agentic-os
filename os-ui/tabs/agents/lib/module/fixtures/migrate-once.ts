/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    One booting process's agent_runs migration (the WP-53b concurrency test runs two at once)
 * USER STORY: As the operator I want os-ui and os-ui-worker booting together to migrate once and
 *             both succeed.
 * ARCHITECTURE:
 *   - `node --import ./scripts/test-setup.mjs tabs/agents/lib/module/fixtures/migrate-once.ts <url>`
 *     prints one JSON line: what node-pg-migrate ran.
 */
import { migrateAgentRuns } from '@core/adapters/postgres/migrate';

const r = await migrateAgentRuns({ databaseUrl: process.argv[2] ?? '' });
process.stdout.write(`${JSON.stringify(r)}\n`);
process.exit(r.ok ? 0 : 1);
