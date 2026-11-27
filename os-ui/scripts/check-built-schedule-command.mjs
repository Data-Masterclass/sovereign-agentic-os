/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       os-ui build checks
 * FEATURE:    The compiled schedule trigger command is intact
 * USER STORY: As an owner of a scheduled agent I need the CronJob the OS writes to carry a working
 *             curl command, so the agent actually runs on its schedule.
 * ARCHITECTURE: The production bundler once folded the template-literal shell string in
 *             tabs/agents/lib/schedule-cron.ts and dropped `: os-ui" `, so every scheduled run failed
 *             with an unterminated quote although the source and its unit tests were correct. This
 *             runs AFTER `next build` and reads the compiled server output: the trigger must be the
 *             shell-free argv (`$(SCHEDULE_CRON)` present) and the mangled form must be absent.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.next', 'server');
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.js')) files.push(p);
  }
})(root);

let found = 0;
const problems = [];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (!s.includes('X-Schedule-Source')) continue;
  if (s.includes('X-Schedule-Source-H')) problems.push(`${f}: mangled header string`);
  if (/\/bin\/sh[^]{0,400}X-Schedule-Source|X-Schedule-Source[^]{0,400}\/bin\/sh/.test(s)) problems.push(`${f}: trigger still runs through a shell`);
  // Every argv piece must survive the build (joined or folded): the source marker, the cron
  // marker and the bearer reference.
  const ok = s.includes('$(SCHEDULE_CRON)') && (s.includes('X-Schedule-Source: os-ui') || /X-Schedule-Source[^]{0,200}"os-ui"/.test(s)) && s.includes('$(RUNTIME_TOKEN)');
  if (ok) found += 1;
}
if (found === 0) problems.push('no compiled server chunk contains the shell-free trigger argv ($(SCHEDULE_CRON))');
if (problems.length) {
  console.error('check-built-schedule-command: FAIL\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`check-built-schedule-command: ok (${found} chunk(s) carry the shell-free trigger)`);
