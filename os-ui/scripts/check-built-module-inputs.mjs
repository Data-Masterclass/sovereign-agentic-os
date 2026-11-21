#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling (CI `build` job, after `next build`)
 * FEATURE:    WP-53e — the BUILT server can read the agent-module generator's host inputs
 * USER STORY: As the operator I want CI to fail when the bundled os-ui cannot produce a graph.mjs,
 *             not the first agent-definition commit in a cluster (`987.lastIndexOf is not a
 *             function`: in the webpack bundle `require.resolve` returned a module id).
 * ARCHITECTURE:
 *   - Lays the standalone output out like the image (package-lock.json beside server.js, the same
 *     OS_UI_LOCKFILE the Dockerfile sets), boots `node server.js` with AGENT_GRAPH_MODULE on, and
 *     waits for instrumentation's boot line: "agent modules: host inputs ok" passes, "NOT
 *     readable" (or no line within the deadline) fails. The boot check calls the SAME
 *     `hostModuleInputs()` the commit path calls (and the `node_modules` lookup an inline module run
 *     links to), inside the same bundle.
 *   - Needs `npm run build` first; no other service (the server boots without its backends).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = path.join(OS_UI, '.next', 'standalone');
if (!existsSync(path.join(STANDALONE, 'server.js'))) {
  console.error('check-built-module-inputs: no .next/standalone/server.js — run `npm run build` first');
  process.exit(1);
}
const lockfile = path.join(STANDALONE, 'package-lock.json');
copyFileSync(path.join(OS_UI, 'package-lock.json'), lockfile);

const port = String(40000 + Math.floor(Math.random() * 20000));
const child = spawn(process.execPath, ['server.js'], {
  cwd: STANDALONE,
  // No credentials: the boot check runs before the production secret guard, which then stops the
  // boot — the line this script needs is already out by then.
  env: { ...process.env, NODE_ENV: 'production', PORT: port, HOSTNAME: '127.0.0.1', AGENT_GRAPH_MODULE: 'true', AGENT_GRAPH_MODULE_DOMAINS: 'test', OS_UI_LOCKFILE: lockfile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const done = (code, msg) => {
  child.kill('SIGKILL');
  (code ? console.error : console.log)(`check-built-module-inputs: ${msg}`);
  if (code && process.env.DEBUG_BOOT) console.error(out);
  else if (code) console.error(out.split('\n').filter((l) => /agent modules|Error|error|Refusing/.test(l)).slice(0, 20).join('\n'));
  process.exit(code);
};
const onData = (b) => {
  out += b.toString();
  if (/\[os-ui\] agent modules: host inputs ok/.test(out)) done(0, `ok — ${out.match(/agent modules: host inputs ok[^\n]*/)[0]}`);
  else if (/\[os-ui\] agent modules: host inputs NOT readable/.test(out)) done(1, 'FAILED — the built server cannot read the module host inputs');
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (c) => setTimeout(() => done(1, `FAILED — the server exited (${c}) before the boot check reported`), 200));
setTimeout(() => done(1, 'FAILED — no agent-modules boot line within 120 s'), 120_000).unref();
