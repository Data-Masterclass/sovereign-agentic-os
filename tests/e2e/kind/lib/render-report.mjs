#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Per-assertion report of a harness run (Markdown + JSON)
 * USER STORY: As the owner I want one page per run that lists every acceptance assertion and every
 *             negative twin with its status, the hop, the component record it reads, and the reason
 *             it is red, so "all red, with the reason per hop" is something I can read.
 * ARCHITECTURE:
 *   - Reads $1/results.jsonl (written by lib/journey.mjs), writes $1/report.json and $1/report.md.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'report';
const lines = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const rows = lines('results.jsonl');
// Journeys run.sh skipped, with the reason (e.g. the kind-only model stub on the dev cluster).
const skipped = lines('skipped.jsonl');
const by = (k) => rows.reduce((m, r) => ((m[r[k]] ??= []).push(r), m), {});
const count = (rs, s) => rs.filter((r) => r.status === s).length;
const esc = (s) => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

const summary = Object.entries(by('journey')).map(([j, rs]) => ({
  journey: j, title: rs[0].title, total: rs.length,
  red: count(rs, 'red'), green: count(rs, 'green'), unexpectedGreen: count(rs, 'unexpected-green'), failed: count(rs, 'failed'),
}));

const totals = {
  total: rows.length,
  expectedRed: count(rows, 'red'),
  green: count(rows, 'green'),
  unexpectedGreen: count(rows, 'unexpected-green'),
  failed: count(rows, 'failed'),
  skippedJourneys: skipped.length,
};
let md = `# Acceptance harness report\n\nRun: ${rows[0]?.at ?? 'n/a'} · cluster \`${process.env.E2E_KUBE_CONTEXT || `kind-${process.env.E2E_CLUSTER ?? 'wp02'}`}\`\n\n`;
md += 'Status: **red** = expected-fail and red (the target system is not there yet) · **green** · **unexpected-green** = marked expected-fail but passed (remove the marker) · **failed** = not marked and red (harness or regression).\n\n';
md += `**Totals:** ${totals.total} results: ${totals.expectedRed} expected-fail (red as marked), ${totals.green} green, ${totals.unexpectedGreen} unexpected-green, ${totals.failed} failed (unexpected). Unexpected: **${totals.unexpectedGreen + totals.failed}**. Journeys skipped: ${totals.skippedJourneys}.\n\n`;
if (skipped.length) {
  md += '| Skipped journey | Reason |\n|---|---|\n';
  for (const k of skipped) md += `| ${esc(k.file)} | ${esc(k.reason)} |\n`;
  md += '\n';
}
md += '| Journey | Total | red | green | unexpected-green | failed |\n|---|---|---|---|---|---|\n';
for (const s of summary) md += `| ${s.journey} ${s.title} | ${s.total} | ${s.red} | ${s.green} | ${s.unexpectedGreen} | ${s.failed} |\n`;
for (const [j, rs] of Object.entries(by('journey'))) {
  md += `\n## ${j} — ${rs[0].title}\n\n| Id | Kind | Hop | Record read | Status | Component | Reason | Closed by |\n|---|---|---|---|---|---|---|---|\n`;
  for (const r of rs) md += `| ${r.id} | ${r.kind}${r.mustBe === 'green' ? ' (must stay green)' : ''} | ${esc(r.hop)} | ${esc(r.record)} | ${r.status} | ${esc(r.component)} | ${esc(r.reason)} | ${esc(r.closedBy ?? r.expectedFail)} |\n`;
}
writeFileSync(join(dir, 'report.md'), md);
writeFileSync(join(dir, 'report.json'), JSON.stringify({ totals, summary, skipped, rows }, null, 2));
console.log(md.split('\n## ')[0]);
