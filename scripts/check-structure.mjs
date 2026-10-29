#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    Structural guard for the core / tabs / components layout
 * USER STORY: As a maintainer I want CI to refuse a change that smuggles tab code into the
 *             kernel, couples two tabs, puts our code inside an upstream component folder, or
 *             lands a source file with no explanation of what it does.
 * ARCHITECTURE:
 *   - Pure filesystem + regex checks, no dependencies, no network. Exits 1 on any violation.
 *   - Five rules (below). Each prints every offending path, not just the first.
 *   - Runs before the layout migration too: missing core//tabs/ is reported, not crashed on.
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = process.cwd();
const UI = 'os-ui';
const problems = [];
const fail = (rule, path, detail) => problems.push(`${rule}  ${path}${detail ? ` — ${detail}` : ''}`);

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e.startsWith('.')) continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const code = (f) => /\.(ts|tsx|mjs|py|rego)$/.test(f) && !/\.d\.ts$/.test(f);

// ---- rule 1: components/ holds upstream material only -----------------------
const UPSTREAM_OK = /^(UPSTREAM|README|LICENSE|NOTICE)(\.md)?$/;
for (const f of walk('components')) {
  const rel = relative('components', f);
  const base = rel.split('/').pop();
  if (!UPSTREAM_OK.test(base)) {
    fail('COMPONENT-UPSTREAM-ONLY', `components/${rel}`, 'only UPSTREAM.md / LICENSE / README belong here; our code goes in the chart or the owning tab');
  }
}

// ---- rules 2-5 need the migrated layout ------------------------------------
const coreDir = join(UI, 'core');
const tabsDir = join(UI, 'tabs');
if (!existsSync(coreDir) || !existsSync(tabsDir)) {
  console.log(`check-structure: ${UI}/core and ${UI}/tabs do not exist yet — layout rules skipped (component rule still ran).`);
} else {
  const tabs = readdirSync(tabsDir).filter((t) => statSync(join(tabsDir, t)).isDirectory());

  // rule 2: a tab imports only @core/* and its own folder
  const importRe = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g;
  for (const tab of tabs) {
    for (const f of walk(join(tabsDir, tab)).filter(code)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(importRe)) {
        const spec = m[1];
        const other = spec.match(/^@tabs\/([^/'"]+)/);
        if (other && other[1] !== tab) fail('TAB-ISOLATION', f, `imports @tabs/${other[1]} — cross-tab needs go through @core`);
        if (/^@\/(lib|app|components)\//.test(spec)) fail('LEGACY-IMPORT', f, `${spec} — use @core/* or a path inside this tab`);
      }
    }
  }

  // rule 3: the kernel never depends on a tab
  for (const f of walk(coreDir).filter(code)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(importRe)) {
      if (m[1].startsWith('@tabs/')) fail('CORE-INDEPENDENCE', f, `imports ${m[1]} — the kernel must not know its tabs`);
    }
  }

  // rule 4: every tab declares a manifest
  for (const tab of tabs) {
    if (!existsSync(join(tabsDir, tab, 'manifest.ts'))) fail('TAB-MANIFEST', `${tabsDir}/${tab}`, 'missing manifest.ts (feature key, nav, routes, api, mcpTools, policies, services)');
  }

  // rule 5: every source file explains itself
  const SECTIONS = ['FEATURE:', 'USER STORY:', 'ARCHITECTURE:'];
  for (const f of [...walk(coreDir), ...walk(tabsDir)].filter(code)) {
    const head = readFileSync(f, 'utf8').slice(0, 2000);
    const missing = SECTIONS.filter((s) => !head.includes(s));
    if (missing.length) fail('FILE-HEADER', f, `header missing ${missing.join(' ')}`);
  }
}

// ---- ratchet ---------------------------------------------------------------
// Two rules must always be clean; the other three carry a real backlog from the
// v1 codebase, so they are ratcheted: CI fails when a count GROWS, never because
// the backlog still exists. Shrink the baseline as the backlog is paid down.
const BASELINE_FILE = 'scripts/structure-baseline.json';
const counts = {};
for (const p of problems) { const rule = p.trim().split(/\s+/)[0]; counts[rule] = (counts[rule] ?? 0) + 1; }
const HARD = ['COMPONENT-UPSTREAM-ONLY', 'TAB-MANIFEST'];
const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : {};

if (process.argv.includes('--baseline')) {
  writeFileSync(BASELINE_FILE, JSON.stringify(counts, null, 2) + '\n');
  console.log('check-structure: baseline written', JSON.stringify(counts));
  process.exit(0);
}

const show = (rule) => problems.filter((p) => p.trim().startsWith(rule)).slice(0, 10);
let failed = false;
for (const rule of new Set([...HARD, ...Object.keys(counts), ...Object.keys(baseline)])) {
  const now = counts[rule] ?? 0;
  const was = HARD.includes(rule) ? 0 : (baseline[rule] ?? 0);
  if (now > was) {
    failed = true;
    console.error(`\n${rule}: ${now} (baseline ${was}) — ${now - was} new violation(s)`);
    for (const p of show(rule)) console.error('  ' + p);
  } else if (now < was) {
    console.log(`${rule}: ${now} (baseline ${was}) — ${was - now} fewer; run --baseline to lock it in`);
  } else if (now > 0) {
    console.log(`${rule}: ${now} (at baseline — known backlog)`);
  }
}
if (failed) {
  console.error('\nRules: components/ is upstream-only · a tab imports only @core and itself · core never imports a tab · every tab has a manifest · every source file carries a FEATURE / USER STORY / ARCHITECTURE header.\n');
  process.exit(1);
}
console.log('check-structure: ok (no new violations)');
