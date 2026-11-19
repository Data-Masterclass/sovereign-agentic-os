/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { ALL_MCP_TOOLS } from '@core/mcp/server';
import { ALL_WRITE_TOOLS } from '@core/mcp/write-tools';
import { WRITE_TOOL_NAMES, AGENT_FORBIDDEN_TOOLS } from '@core/mcp/write-tool-meta';
import {
  READ_TOOLS,
  UNCLASSIFIED_BACKLOG,
  CONFIRM_FREE,
  CONFIRM_FREE_CATALOGUED_TOOLS,
  needsUserConfirm,
  toolClass,
} from '@core/mcp/tool-classes';

const HERE = dirname(fileURLToPath(import.meta.url));
const OS_UI = resolve(HERE, '../..');

test('every registered tool is in EXACTLY ONE confirm class — and none is unknown', () => {
  const reads = new Set(READ_TOOLS);
  const backlog = new Set(UNCLASSIFIED_BACKLOG);
  const free = new Set(Object.keys(CONFIRM_FREE_CATALOGUED_TOOLS));
  const counts: Record<string, number> = {};
  for (const { name } of ALL_MCP_TOOLS) {
    // Membership is computed here from the raw lists, independently of `toolClass`, so an
    // ordering bug in `toolClass` cannot hide an overlap.
    const hits = [
      reads.has(name) && 'read',
      free.has(name) && 'confirm-free-catalogued',
      WRITE_TOOL_NAMES.has(name) && !free.has(name) && 'write',
      backlog.has(name) && 'backlog',
    ].filter(Boolean) as string[];
    assert.deepEqual(hits.length, 1, `${name} is in ${hits.length} classes: [${hits.join(', ')}]`);
    assert.equal(toolClass(name), hits[0], `toolClass('${name}')`);
    counts[hits[0]] = (counts[hits[0]] ?? 0) + 1;
  }
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), ALL_MCP_TOOLS.length);
  assert.equal(counts['confirm-free-catalogued'], Object.keys(CONFIRM_FREE_CATALOGUED_TOOLS).length);
});

test('needsUserConfirm is fail-closed: unknown names, backlog tools and every other catalogued write need confirmation', () => {
  for (const name of ['', 'no_such_tool', 'CREATE_DATASET', ' query_data', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(needsUserConfirm(name), true, `'${name}' must need confirmation`);
    assert.equal(toolClass(name), 'unknown');
  }
  for (const name of UNCLASSIFIED_BACKLOG) assert.equal(needsUserConfirm(name), true, `backlog tool ${name}`);
  for (const name of WRITE_TOOL_NAMES) {
    const listed = Object.hasOwn(CONFIRM_FREE_CATALOGUED_TOOLS, name);
    assert.equal(needsUserConfirm(name), !listed, `catalogued write ${name}`);
  }
  for (const name of READ_TOOLS) assert.equal(needsUserConfirm(name), false, `reviewed read ${name}`);
});

test('CONFIRM_FREE is exactly the reviewed reads plus the reasoned exceptions — nothing else gets in', () => {
  assert.deepEqual([...CONFIRM_FREE].sort(), [...READ_TOOLS, ...Object.keys(CONFIRM_FREE_CATALOGUED_TOOLS)].sort());
  assert.equal(CONFIRM_FREE.size, READ_TOOLS.length + Object.keys(CONFIRM_FREE_CATALOGUED_TOOLS).length, 'a name is listed twice');
  const registered = new Set(ALL_MCP_TOOLS.map((t) => t.name));
  assert.deepEqual([...CONFIRM_FREE].filter((n) => !registered.has(n)), [], 'CONFIRM_FREE names a tool that is not registered');
});

test('every confirm-free tool that sits in a WRITE BARREL or the write catalog is listed with a reason', () => {
  const barrel = new Set(ALL_WRITE_TOOLS.map((t) => t.name));
  for (const name of CONFIRM_FREE) {
    if (!barrel.has(name) && !WRITE_TOOL_NAMES.has(name)) continue;
    assert.ok(Object.hasOwn(CONFIRM_FREE_CATALOGUED_TOOLS, name), `${name} is in the write catalog and confirm-free without a listed reason`);
  }
  for (const [name, reason] of Object.entries(CONFIRM_FREE_CATALOGUED_TOOLS)) {
    assert.ok(WRITE_TOOL_NAMES.has(name), `${name} is listed as a catalogued exception but is not in the write catalog`);
    assert.match(reason, /^(read|cost-only): /, `${name} must say which kind of exception it is`);
    assert.ok(reason.length > 60, `${name} must say WHAT the handler does and where the real write is`);
  }
  // The exact reviewed set, so growing it is a visible diff that someone has to justify.
  assert.deepEqual(Object.keys(CONFIRM_FREE_CATALOGUED_TOOLS).sort(), [
    'get_catalog_classification', 'get_catalog_snapshot', 'list_adoptable_actions', 'list_exposed_tables',
    'list_exposure_sets', 'preview_metric', 'propose_quality_fixes', 'suggest_metrics',
  ]);
});

test('the tools that only LOOK cost-only keep needing confirmation — their handlers save something', () => {
  // Read on 2026-11-19: `run_quality_checks` records a run in the durable quality series;
  // `export_okf_bundle` creates a Files artifact; `test_connection` writes the probe status back.
  for (const name of ['run_quality_checks', 'export_okf_bundle', 'test_connection', 'refresh_connection_catalog', 'classify_catalog', 'get_software_status']) {
    assert.equal(needsUserConfirm(name), true, name);
  }
});

test('nothing closed to agent runs, and no approval or destructive verb, is confirm-free', () => {
  for (const name of Object.keys(AGENT_FORBIDDEN_TOOLS)) assert.equal(needsUserConfirm(name), true, name);
  for (const name of CONFIRM_FREE) {
    assert.doesNotMatch(name, /^(delete|archive|retire|revoke|promote|approve|decide|request|publish|create|update|set|apply|adopt|commit|push|go_live|run_|build_|import|upload)/, `${name} reads like a write`);
  }
});

test('GROUNDWORK ONLY: no production file consults the confirm classes yet', () => {
  // The classification ships before the gate. Until the gate is wired, an import of this module
  // from production code would be a behaviour change smuggled into a no-behaviour-change PR.
  // LATER PRs add their consumer to ALLOWED — a reviewed, one-line diff.
  const ALLOWED = new Set<string>(['core/mcp/tool-classes.ts']);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
      const rel = relative(OS_UI, full);
      if (ALLOWED.has(rel)) continue;
      if (/tool-classes|needsUserConfirm|CONFIRM_FREE/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
    }
  };
  for (const top of ['app', 'core', 'tabs', 'components', 'lib', 'scripts']) {
    try { walk(resolve(OS_UI, top)); } catch { /* a top-level dir this checkout does not have */ }
  }
  assert.deepEqual(offenders, []);
});
