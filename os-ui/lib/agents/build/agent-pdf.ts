/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { jsPDF } from 'jspdf';
import type { System } from '../system-schema.ts';
import type { DiagRun } from './run-diagnostics.ts';
import { reportFilename } from './run-diagnostics.ts';
import { renderSystemGraphSvg } from './system-graph-svg.ts';
import { buildEvalReport, agentDisplayName, type EvalReport } from './eval-report.ts';
import type { Check } from './run-checks.ts';
import type { JudgeResult } from '../evaluate-judge.ts';

/**
 * Browser-only PDF painters for the Agents Run + Evaluate reports. The DATA assembly
 * lives in pure, unit-tested modules (`eval-report`, `system-graph-svg`); this file is
 * the thin, jsPDF-bound painter that mirrors the on-screen views onto a branded page.
 * Shared with `WorkflowView`'s Export-PDF stack (jsPDF + SVG→PNG rasterise), so the
 * look is consistent across the app.
 */

const M = 40; // page margin (pt)
const INK: [number, number, number] = [20, 20, 20];
const MUTED: [number, number, number] = [110, 110, 110];
const GOLD: [number, number, number] = [150, 120, 30];
const GREEN: [number, number, number] = [30, 120, 70];
const RED: [number, number, number] = [150, 40, 40];

/** A tiny painter façade so both reports share header/heading/paragraph typography. */
type Painter = {
  doc: jsPDF;
  W: number;
  H: number;
  y: number;
  /** Write a paragraph (auto-wrap + page-break); returns the painter for chaining. */
  text: (s: string, size?: number, bold?: boolean, gap?: number, color?: [number, number, number]) => void;
  /** Vertical space. */
  space: (h?: number) => void;
  /** A section heading with a gold rule under it. */
  heading: (s: string, size?: number) => void;
  /** Page break to a fresh page. */
  page: () => void;
  /** Render a markdown string (GFM tables → real tables; headings/bullets/paras). */
  markdown: (md: string | undefined, size?: number) => void;
};

function makePainter(doc: jsPDF, autoTable: (d: jsPDF, o: Record<string, unknown>) => void): Painter {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const p: Painter = {
    doc,
    W,
    H,
    y: M,
    text(s, size = 10, bold = false, gap = 14, color = INK) {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...color);
      for (const l of doc.splitTextToSize(s, W - M * 2)) {
        if (p.y > H - M) { doc.addPage(); p.y = M; }
        doc.text(l, M, p.y);
        p.y += gap;
      }
    },
    space(h = 8) { p.y += h; },
    heading(s, size = 13) {
      if (p.y > H - M - 30) { doc.addPage(); p.y = M; }
      p.space(6);
      p.text(s, size, true, size + 5);
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1);
      doc.line(M, p.y - size + 2, W - M, p.y - size + 2);
      p.space(6);
    },
    page() { doc.addPage(); p.y = M; },
    markdown(md, size = 10) {
      const cleanInline = (s: string) =>
        s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/`(.*?)`/g, '$1').replace(/^#+\s*/, '').trimEnd();
      const splitRow = (s: string) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => cleanInline(c.trim()));
      const isTableSep = (s: string) => /-{2,}/.test(s) && /^[\s:|-]+$/.test(s.trim());
      const afterTableY = () => ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? p.y);
      const lines = (md ?? '').replace(/\r/g, '').split('\n');
      let i = 0;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const head = splitRow(ln);
          const rows: string[][] = [];
          i += 2;
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i += 1; }
          if (p.y > H - M - 40) { doc.addPage(); p.y = M; }
          autoTable(doc, {
            startY: p.y,
            head: [head],
            body: rows,
            margin: { left: M, right: M },
            styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
            headStyles: { fillColor: [30, 30, 30] },
          });
          p.y = afterTableY() + 12;
          continue;
        }
        const h = ln.match(/^(#{1,6})\s+(.*)$/);
        if (h) { p.space(2); p.text(cleanInline(h[2]), size + 1, true, 15); i += 1; continue; }
        if (ln.trim() === '') { p.space(4); i += 1; continue; }
        const b = ln.match(/^\s*[-*+]\s+(.*)$/);
        if (b) { p.text(`•  ${cleanInline(b[1])}`, size); i += 1; continue; }
        p.text(cleanInline(ln), size);
        i += 1;
      }
    },
  };
  return p;
}

/**
 * Rasterise a standalone SVG string to a PNG data URL at `scale`× so a vector graph
 * embeds crisply in the PDF. Browser-only (Image + canvas). Returns null on failure so
 * the export can still produce the text sections. Mirror of WorkflowView.svgToPng.
 */
async function svgToPng(svg: string, w: number, h: number, scale = 2): Promise<{ dataUrl: string; w: number; h: number } | null> {
  try {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('graph image failed to load'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/png'), w, h };
  } catch {
    return null;
  }
}

/** Branded header band — title + a "who ran it / when" line, consistent across reports. */
function header(p: Painter, title: string, sub: string, ranLine: string): void {
  p.text(title, 18, true, 22);
  if (sub) p.text(sub, 10.5, false, 15, MUTED);
  p.text(ranLine, 9, false, 13, MUTED);
  p.space(4);
}

/**
 * RUN report — EXACTLY the Run screen: the run summary + per-agent results + the final
 * output. No assessment/diagnostics (those live under Evaluate). `labelOf` maps agent
 * ids to their display (short) names so the PDF matches the on-screen cards.
 */
export async function downloadRunPdf(
  system: System,
  run: DiagRun,
  meta: { ranBy: string; at: number; prompt: string },
): Promise<void> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default as unknown as (d: jsPDF, o: Record<string, unknown>) => void;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const p = makePainter(doc, autoTable);
  const nameOf = (id: string) => {
    const a = system.agents.find((x) => x.id === id);
    return a ? agentDisplayName(a) : id;
  };

  const calls = (run.nodes ?? []).reduce((s, n) => s + n.steps.length, 0);
  const summary = `${run.ok ? 'Completed' : 'Completed with issues'} · ${calls} governed call${calls === 1 ? '' : 's'} across ${(run.nodes ?? []).length} agent${(run.nodes ?? []).length === 1 ? '' : 's'}`;

  header(
    p,
    system.system.name || 'Agent run',
    `Run results · ${summary}`,
    `Ran by ${meta.ranBy || 'unknown'} · ${new Date(meta.at).toISOString()} · mode: ${run.mode ?? 'live'}`,
  );

  p.text('Task', 11, true);
  p.text(meta.prompt?.trim() || '(default task)', 10);
  p.space(2);
  p.text('Path', 11, true);
  p.text(run.path.length ? `${run.path.join(' → ')} → END` : '(no path)', 10);

  // Final output — the headline result, straight from the run.
  p.heading('Final output', 13);
  p.markdown((run.output ?? '').trim() || '(the run produced no final text)', 10);

  // Per-agent results — one block per agent, exactly the Run cards.
  if ((run.nodes ?? []).length > 0) {
    p.heading('Per-agent results', 13);
    for (const n of run.nodes ?? []) {
      p.space(2);
      const meta2 = [n.model, n.tier].filter(Boolean).join(' · ');
      p.text(
        `${nameOf(n.node)} — ${n.status}${meta2 ? ` · ${meta2}` : ''} · ${n.steps.length} call${n.steps.length === 1 ? '' : 's'}`,
        10.5,
        true,
        14,
        n.status === 'ok' ? GREEN : RED,
      );
      const out = (n.finalText ?? '').trim() || '(no output)';
      p.markdown(out.length > 3000 ? `${out.slice(0, 3000)}…` : out, 9);
    }
  }

  doc.save(reportFilename(system.system.name || 'run', meta.at));
}

/**
 * EVALUATE report — graph first, then EXACTLY the Evaluate screen, then the three
 * appendices (Results · Define settings · Agent descriptions) and NOTHING else.
 */
export async function downloadEvalPdf(
  system: System,
  run: DiagRun,
  checks: Check[],
  judge: JudgeResult | null,
  meta: { ranBy: string; at: number },
): Promise<void> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default as unknown as (d: jsPDF, o: Record<string, unknown>) => void;
  const report: EvalReport = buildEvalReport(system, run, checks, judge, meta);
  const nameOf = (id: string) => {
    const a = system.agents.find((x) => x.id === id);
    return a ? agentDisplayName(a) : id;
  };

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const p = makePainter(doc, autoTable);

  header(
    p,
    report.title,
    'Evaluation report',
    `Ran by ${report.ranBy} · ${report.timestamp}`,
  );

  // ── PAGE 1: the visual system graph ──────────────────────────────────────
  p.heading('Multi-agent system', 14);
  const { svg, width, height } = renderSystemGraphSvg(system, { labelOf: nameOf });
  const png = system.agents.length > 0 ? await svgToPng(svg, width, height) : null;
  if (png) {
    const availW = p.W - M * 2;
    const availH = p.H - p.y - M;
    const ratio = Math.min(availW / png.w, availH / png.h, 1);
    const dw = png.w * ratio;
    const dh = png.h * ratio;
    doc.addImage(png.dataUrl, 'PNG', M + (availW - dw) / 2, p.y, dw, dh);
    p.y += dh + 8;
  } else {
    p.text(system.agents.length === 0 ? 'No agents yet — the graph is empty.' : 'The graph could not be rendered.', 10, false, 14, MUTED);
  }

  // ── MAIN BODY: exactly the Evaluate screen (Checks + AI judge) ────────────
  p.page();
  p.heading('Checks', 14);
  p.text(report.checks.allPass ? 'All checks passed.' : `${report.checks.rows.filter((r) => !r.pass).length} check(s) to look at.`, 10, false, 15, report.checks.allPass ? GREEN : RED);
  for (const c of report.checks.rows) {
    p.space(2);
    p.text(`${c.pass ? '✓' : '✗'}  ${c.label}`, 10.5, true, 14, c.pass ? GREEN : RED);
    p.text(c.detail, 9.5, false, 13, MUTED);
  }

  if (report.judge) {
    p.heading('AI judge', 14);
    p.text(`Overall ${report.judge.overall} / 5`, 11, true, 16, GOLD);
    for (const r of report.judge.rows) {
      p.space(2);
      p.text(`${r.dimension} — ${r.score}/5`, 10.5, true, 14);
      p.text(r.why, 9.5, false, 13, MUTED);
    }
  }

  // ── APPENDIX 1 — Results ─────────────────────────────────────────────────
  p.page();
  p.heading('Appendix 1 — Results', 14);
  p.text('Path', 11, true);
  p.text(report.results.path, 10);
  p.heading('Final output', 12);
  p.markdown(report.results.finalOutput, 10);
  if (report.results.agents.length > 0) {
    p.heading('Per-agent outputs', 12);
    for (const a of report.results.agents) {
      p.space(2);
      const m = [a.model, a.tier].filter(Boolean).join(' · ');
      p.text(`${a.name} — ${a.decision}${m ? ` · ${m}` : ''} · ${a.calls} call${a.calls === 1 ? '' : 's'}`, 10.5, true, 14);
      p.markdown(a.output.length > 2500 ? `${a.output.slice(0, 2500)}…` : a.output, 9);
    }
  }

  // ── APPENDIX 2 — Define-stage settings ───────────────────────────────────
  p.page();
  p.heading('Appendix 2 — Define-stage settings', 14);
  p.text('Team name', 11, true);
  p.text(report.define.name, 10);
  p.space(2);
  p.text('Purpose / success criteria', 11, true);
  p.markdown(report.define.purpose, 10);
  p.space(2);
  p.text('Safety preset', 11, true);
  p.text(report.define.safety, 10);
  p.space(2);
  p.text('Trigger mode', 11, true);
  p.text(report.define.trigger, 10);
  p.heading('What your team can use', 12);
  if (report.define.grants.length === 0) {
    p.text('Nothing granted.', 10, false, 14, MUTED);
  } else {
    for (const grp of report.define.grants) {
      p.space(2);
      p.text(grp.kind, 10.5, true, 14);
      for (const l of grp.lines) p.text(`•  ${l}`, 9.5, false, 13, MUTED);
    }
  }

  // ── APPENDIX 3 — Agent descriptions ──────────────────────────────────────
  p.page();
  p.heading('Appendix 3 — Agent descriptions', 14);
  if (report.agentDescriptions.length === 0) {
    p.text('No agents.', 10, false, 14, MUTED);
  } else {
    report.agentDescriptions.forEach((a, i) => {
      if (i > 0) p.space(6);
      p.text(a.name, 12, true, 16);
      p.text(`Role: ${a.role}`, 9.5, false, 13, MUTED);
      p.space(2);
      p.markdown(a.instructions, 9.5);
    });
  }

  doc.save(reportFilename(`${system.system.name || 'team'}-evaluation`, meta.at));
}
