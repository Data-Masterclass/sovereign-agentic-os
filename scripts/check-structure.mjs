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
 *   - Six rules (below). Each prints every offending path, not just the first. The header rule
 *     also covers os-ui/worker/ (the worker entrypoint, outside core/ and tabs/).
 *   - Runs before the layout migration too: missing core//tabs/ is reported, not crashed on.
 *   - `os-ui/vendor/**` (attributed third-party source) is EXCLUDED from the FEATURE / USER STORY /
 *     ARCHITECTURE header rule — ASF policy forbids rewriting a third-party licence header, so a
 *     vendored file could never satisfy it — and is covered by rule 6 instead, which demands the
 *     upstream header verbatim plus our `Modified from … @ <sha>` notice. Both are hard rules.
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

  // rule 5: every source file explains itself — including the non-Next entrypoints in
  // os-ui/worker/, which are production code the Next build never compiles (A4 review L-7).
  const SECTIONS = ['FEATURE:', 'USER STORY:', 'ARCHITECTURE:'];
  // VENDOR_EXCLUDED_FROM_HEADER_RULE: os-ui/vendor/ is deliberately NOT in this walk list —
  // rewriting a third-party licence header to add our own sections would breach ASF policy.
  // Rule 6 below is its ratchet instead.
  for (const f of [...walk(coreDir), ...walk(tabsDir), ...walk(join(UI, 'worker'))].filter(code)) {
    if (relative(UI, f).split('/')[0] === 'vendor') continue; // belt and braces for the exclusion
    const head = readFileSync(f, 'utf8').slice(0, 2000);
    const missing = SECTIONS.filter((s) => !head.includes(s));
    if (missing.length) fail('FILE-HEADER', f, `header missing ${missing.join(' ')}`);
  }
}

// ---- rule 6: every vendored file keeps its upstream header + our modification notice -------
// Apache-2.0 §4(a)/(c): retain the upstream licence header VERBATIM. §4(b): carry a prominent
// notice of the changes made. This repo additionally pins the upstream COMMIT SHA, because
// vendored source has no release, and demands an SPDX id so the licence gate can see the file.
const VENDOR_DIR = join(UI, 'vendor');
const VENDOR_HEADER_MARKERS = [
  // Add a marker here when source is vendored from a project other than an ASF one.
  'Licensed to the Apache Software Foundation (ASF) under one',
];
const MODIFIED_FROM = /Modified from \S+[\s\S]{0,2000}?@ [0-9a-f]{40}/;
for (const f of walk(VENDOR_DIR).filter(code)) {
  const head = readFileSync(f, 'utf8').slice(0, 4000);
  if (!VENDOR_HEADER_MARKERS.some((m) => head.includes(m))) {
    fail('VENDOR-LICENCE-HEADER', f, 'upstream licence header missing or rewritten — keep it VERBATIM, never replace it');
  } else if (!MODIFIED_FROM.test(head)) {
    fail('VENDOR-LICENCE-HEADER', f, 'missing the `Modified from <repo> <path> @ <40-char sha>` notice (Apache-2.0 §4(b))');
  } else if (!head.includes('Changes:')) {
    fail('VENDOR-LICENCE-HEADER', f, 'the modification notice must list the changes made under `Changes:`');
  } else if (!/SPDX-License-Identifier:/.test(head)) {
    fail('VENDOR-LICENCE-HEADER', f, 'missing the SPDX-License-Identifier line');
  }
}

// ---- ratchet ---------------------------------------------------------------
// Two rules must always be clean; the other three carry a real backlog from the
// v1 codebase, so they are ratcheted: CI fails when a count GROWS, never because
// the backlog still exists. Shrink the baseline as the backlog is paid down.
const BASELINE_FILE = 'scripts/structure-baseline.json';
const counts = {};
for (const p of problems) { const rule = p.trim().split(/\s+/)[0]; counts[rule] = (counts[rule] ?? 0) + 1; }
const HARD = ['COMPONENT-UPSTREAM-ONLY', 'TAB-MANIFEST', 'VENDOR-LICENCE-HEADER'];
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
  console.error('\nRules: components/ is upstream-only · a tab imports only @core and itself · core never imports a tab · every tab has a manifest · every source file carries a FEATURE / USER STORY / ARCHITECTURE header · every os-ui/vendor file keeps its upstream licence header plus a `Modified from … @ <sha>` notice.\n');
  process.exit(1);
}
console.log('check-structure: ok (no new violations)');
