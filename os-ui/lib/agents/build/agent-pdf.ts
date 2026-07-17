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
import { registerBrandFonts, BRAND, Fonts, Fallback } from './brand-fonts.ts';
import { LOTUS_SVG } from './brand-lotus.ts';

/**
 * Browser-only PDF painters for the Agents Run + Evaluate reports, styled to the
 * datamasterclass brand (matching docs/assets/guide.css): a near-black gold-lotus
 * cover, Marcellus section headings over a thin gold rule, Oswald uppercase
 * eyebrows, Rubik body, gold-header zebra tables, and a running footer.
 *
 * The DATA assembly lives in pure, unit-tested modules (`eval-report`,
 * `system-graph-svg`); this file is the thin, jsPDF-bound painter that mirrors the
 * on-screen views onto a branded page. The brand faces are real TTFs embedded via
 * `registerBrandFonts` (falling back to core fonts, palette + logo intact, only if
 * embedding fails).
 */

const M = 52; // page margin (pt) — generous, editorial
const RM = 52; // right margin
const FOOT = 30; // footer band height reserved at page bottom

/** A painter façade so both reports share the branded typography + layout. */
type Painter = {
  doc: jsPDF;
  W: number;
  H: number;
  y: number;
  brand: boolean;
  /** Family resolver honouring the brand/fallback split. */
  fam: (role: keyof typeof Fonts) => string;
  /** Body paragraph (auto-wrap + page-break). */
  text: (s: string, size?: number, bold?: boolean, gap?: number, color?: [number, number, number]) => void;
  /** Uppercase condensed eyebrow / label line (Oswald). `dot` draws a small filled
   *  status disc before the label (its own colour) — used for pass/fail rows, since
   *  the subset font has no ✓/✗ glyph. */
  eyebrow: (s: string, color?: [number, number, number], dot?: [number, number, number]) => void;
  /** Vertical space. */
  space: (h?: number) => void;
  /** A section heading (Marcellus) with a thin gold rule under it. */
  heading: (s: string, size?: number) => void;
  /** A smaller label heading (Oswald eyebrow, no rule) for sub-blocks. */
  subhead: (s: string) => void;
  /** Page break to a fresh page. */
  page: () => void;
  /** Render a markdown string (GFM tables → real tables; headings/bullets/paras). */
  markdown: (md: string | undefined, size?: number) => void;
};

/**
 * Map codepoints the (latin-subset) brand faces lack to close visual equivalents
 * they DO carry, so nothing renders as a blank box/gap. Purely a paint-time render
 * concern — the pure data modules keep their original glyphs (e.g. the flow arrow).
 * `›` (U+203A) stands in for `→`; em/en-dash, bullet, middot, € are all present.
 */
function glyphs(s: string): string {
  return s.replace(/→/g, '›').replace(/[✓✔]/g, '').replace(/[✗✘]/g, '');
}

function makePainter(doc: jsPDF, autoTable: (d: jsPDF, o: Record<string, unknown>) => void, brand: boolean): Painter {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const FAM = brand ? Fonts : Fallback;
  const contentW = W - M - RM;
  const p: Painter = {
    doc,
    W,
    H,
    y: M,
    brand,
    fam: (role) => FAM[role],
    text(s, size = 10, bold = false, gap = 15, color = BRAND.ink) {
      doc.setFont(FAM.body, bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...color);
      for (const l of doc.splitTextToSize(glyphs(s), contentW)) {
        if (p.y > H - M - FOOT) { doc.addPage(); p.y = M; }
        doc.text(l, M, p.y);
        p.y += gap;
      }
    },
    eyebrow(s, color = BRAND.goldText, dot) {
      if (p.y > H - M - FOOT) { doc.addPage(); p.y = M; }
      let x = M;
      if (dot) {
        doc.setFillColor(...dot);
        doc.circle(M + 2.5, p.y - 2.6, 2.6, 'F');
        x = M + 12;
      }
      doc.setFont(FAM.cond, 'normal');
      doc.setFontSize(8.4);
      doc.setTextColor(...color);
      doc.text(spaceCaps(glyphs(s)), x, p.y, { charSpace: brand ? 0.8 : 0.4 });
      p.y += 13;
    },
    space(h = 8) { p.y += h; },
    heading(s, size = 15) {
      if (p.y > H - M - FOOT - 34) { doc.addPage(); p.y = M; }
      p.space(6);
      doc.setFont(FAM.serif, 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...BRAND.inkStrong);
      doc.text(s, M, p.y);
      p.y += 8;
      doc.setDrawColor(...BRAND.gold);
      doc.setLineWidth(1);
      doc.line(M, p.y, M + 46, p.y); // short accent rule, guide-style
      doc.setDrawColor(...BRAND.hair);
      doc.setLineWidth(0.6);
      doc.line(M + 52, p.y, W - RM, p.y); // hairline continuation
      p.space(16);
    },
    subhead(s) {
      p.space(4);
      p.eyebrow(s);
      p.space(1);
    },
    page() { doc.addPage(); p.y = M; },
    markdown(md, size = 10) {
      const cleanInline = (s: string) =>
        glyphs(s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/`(.*?)`/g, '$1').replace(/^#+\s*/, '').trimEnd());
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
          if (p.y > H - M - FOOT - 40) { doc.addPage(); p.y = M; }
          styledTable(autoTable, doc, FAM, p.y, head, rows);
          p.y = afterTableY() + 14;
          continue;
        }
        const h = ln.match(/^(#{1,6})\s+(.*)$/);
        if (h) { p.space(3); p.eyebrow(cleanInline(h[2])); p.space(1); i += 1; continue; }
        if (ln.trim() === '') { p.space(4); i += 1; continue; }
        const b = ln.match(/^\s*[-*+]\s+(.*)$/);
        if (b) { bullet(p, FAM, cleanInline(b[1]), size, contentW); i += 1; continue; }
        p.text(cleanInline(ln), size);
        i += 1;
      }
    },
  };
  return p;
}

/** A gold bullet glyph + hanging-indented body, for markdown/list lines. */
function bullet(p: Painter, FAM: typeof Fonts | typeof Fallback, s: string, size: number, contentW: number): void {
  const { doc, H } = p;
  const indent = 14;
  doc.setFont(FAM.body, 'normal');
  doc.setFontSize(size);
  const wrapped = doc.splitTextToSize(s, contentW - indent) as string[];
  wrapped.forEach((l, idx) => {
    if (p.y > H - M - FOOT) { doc.addPage(); p.y = M; }
    if (idx === 0) {
      doc.setFillColor(...BRAND.goldDeep);
      doc.circle(M + 3, p.y - 3, 1.5, 'F');
    }
    doc.setTextColor(...BRAND.ink);
    doc.text(l, M + indent, p.y);
    p.y += 15;
  });
}

/** The shared branded autotable: gold header, cream text, zebra, hairline grid. */
function styledTable(
  autoTable: (d: jsPDF, o: Record<string, unknown>) => void,
  doc: jsPDF,
  FAM: typeof Fonts | typeof Fallback,
  startY: number,
  head: string[],
  body: string[][],
): void {
  autoTable(doc, {
    startY,
    head: [head],
    body,
    margin: { left: M, right: RM },
    theme: 'grid',
    styles: {
      font: FAM.body,
      fontSize: 8.6,
      cellPadding: { top: 5, right: 8, bottom: 5, left: 8 },
      overflow: 'linebreak',
      textColor: BRAND.ink,
      lineColor: BRAND.hair,
      lineWidth: 0.5,
    },
    headStyles: {
      font: FAM.cond,
      fontStyle: 'normal',
      fontSize: 8.2,
      fillColor: BRAND.gold,
      textColor: BRAND.coverFg,
      cellPadding: { top: 6, right: 8, bottom: 6, left: 8 },
      lineColor: BRAND.gold,
      lineWidth: 0.5,
    },
    alternateRowStyles: { fillColor: BRAND.zebra },
  });
}

/** Space out capitals a touch for eyebrows (kept small; charSpace does most of it). */
function spaceCaps(s: string): string {
  return s.toUpperCase();
}

/**
 * Rasterise a standalone SVG string to a PNG data URL at `scale`× so a vector graph
 * embeds crisply in the PDF. `bg` fills the canvas (default white for interior; pass
 * the cover near-black for the lotus so it sits on the dark cover with no halo).
 * Browser-only (Image + canvas). Returns null on failure so the export still produces
 * the text sections.
 */
async function svgToPng(
  svg: string,
  w: number,
  h: number,
  scale = 2,
  bg = '#ffffff',
): Promise<{ dataUrl: string; w: number; h: number } | null> {
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
    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/png'), w, h };
  } catch {
    return null;
  }
}

/** hex string for a brand triple, e.g. cover bg for the lotus canvas fill. */
function hex([r, g, b]: [number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * The near-black gold-lotus COVER, shared by both reports. `kicker` is the small
 * report-type label ("Results Report" / "Evaluation Report"); `title` the display
 * title (the agent-system name); `sub` an optional one-line summary; `meta` the
 * who/when foot line.
 */
async function coverPage(
  p: Painter,
  kicker: string,
  title: string,
  sub: string,
  meta: string,
): Promise<void> {
  const { doc, W, H } = p;
  const FAM = p.brand ? Fonts : Fallback;
  const cx = W / 2;

  // Full-bleed near-black field.
  doc.setFillColor(...BRAND.coverBg);
  doc.rect(0, 0, W, H, 'F');

  // Top eyebrow + hairline rule (mirrors the guide cover).
  doc.setFont(FAM.cond, 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...BRAND.coverGold);
  doc.text('SOVEREIGN · GOVERNED · SELF-HOSTABLE', M, 64, { charSpace: p.brand ? 2.2 : 1.4 });
  doc.setDrawColor(...BRAND.coverGold);
  doc.setLineWidth(0.5);
  doc.setLineDashPattern([], 0);
  doc.line(M, 74, W - RM, 74);

  // The gold lotus mark, rasterised onto the cover field (no white halo).
  const lot = await svgToPng(LOTUS_SVG, 800, 800, 1.5, hex(BRAND.coverBg));
  const mark = 150;
  if (lot) doc.addImage(lot.dataUrl, 'PNG', cx - mark / 2, 118, mark, mark);

  // Reconstructed brand wordmark (Oswald, wide-tracked) + gold divider.
  doc.setFont(FAM.cond, 'normal');
  doc.setFontSize(15);
  doc.setTextColor(...BRAND.coverFg);
  doc.text('SOVEREIGN AGENTIC OS', cx, 306, { align: 'center', charSpace: p.brand ? 3.2 : 2 });
  doc.setDrawColor(...BRAND.gold);
  doc.setLineWidth(1.4);
  doc.line(cx - 34, 320, cx + 34, 320);

  // Report-type kicker.
  doc.setFont(FAM.cond, 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...BRAND.coverGold);
  doc.text(kicker.toUpperCase(), cx, 392, { align: 'center', charSpace: p.brand ? 2.6 : 1.6 });

  // Display title (Fraunces on brand, big serif otherwise) — the system name.
  doc.setFont(FAM.display, 'normal');
  doc.setTextColor(255, 255, 255);
  const titleSize = title.length > 26 ? 30 : title.length > 16 ? 38 : 46;
  doc.setFontSize(titleSize);
  const tlines = doc.splitTextToSize(title, W - M * 2) as string[];
  let ty = 430;
  for (const l of tlines) { doc.text(l, cx, ty, { align: 'center' }); ty += titleSize * 1.05; }

  // One-line summary in gold serif.
  if (sub) {
    doc.setFont(FAM.serif, 'normal');
    doc.setFontSize(12);
    doc.setTextColor(...BRAND.coverGold);
    const slines = doc.splitTextToSize(sub, W - M * 2 - 60) as string[];
    ty += 6;
    for (const l of slines) { doc.text(l, cx, ty, { align: 'center' }); ty += 18; }
  }

  // Foot: hairline + who/when, cream-muted.
  doc.setDrawColor(...BRAND.coverGold);
  doc.setLineWidth(0.4);
  doc.line(M, H - 96, W - RM, H - 96);
  doc.setFont(FAM.body, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...BRAND.coverMut);
  const mlines = doc.splitTextToSize(meta, W - M * 2) as string[];
  let my = H - 78;
  for (const l of mlines) { doc.text(l, M, my); my += 13; }
  doc.setFont(FAM.cond, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...BRAND.coverMut);
  doc.text('datamasterclass.com', W - RM, H - 78, { align: 'right', charSpace: p.brand ? 1.2 : 0.6 });

  p.page();
}

/**
 * Paint the running footer on every non-cover page: a hairline, the small brand
 * mark on the left and the page number on the right. Called last, once all pages
 * exist, so counts are correct. Page 1 (cover) is skipped.
 */
function paintFooters(doc: jsPDF, brand: boolean): void {
  const FAM = brand ? Fonts : Fallback;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const total = doc.getNumberOfPages();
  for (let i = 2; i <= total; i += 1) {
    doc.setPage(i);
    doc.setDrawColor(...BRAND.hair);
    doc.setLineWidth(0.5);
    doc.line(M, H - 34, W - RM, H - 34);
    doc.setFont(FAM.cond, 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor(...BRAND.muted);
    doc.text('SOVEREIGN AGENTIC OS · DATAMASTERCLASS.COM', M, H - 22, { charSpace: brand ? 0.6 : 0.3 });
    doc.setFont(FAM.body, 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...BRAND.muted);
    doc.text(`${i - 1}`, W - RM, H - 22, { align: 'right' });
  }
}

/** New A4 doc with the brand fonts embedded; returns painter + autoTable + brand flag. */
async function newBrandedDoc(): Promise<{
  doc: jsPDF;
  p: Painter;
  brand: boolean;
}> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default as unknown as (d: jsPDF, o: Record<string, unknown>) => void;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const brand = registerBrandFonts(doc);
  const p = makePainter(doc, autoTable, brand);
  return { doc, p, brand };
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
  const { doc, p, brand } = await newBrandedDoc();
  const nameOf = (id: string) => {
    const a = system.agents.find((x) => x.id === id);
    return a ? agentDisplayName(a) : id;
  };

  const calls = (run.nodes ?? []).reduce((s, n) => s + n.steps.length, 0);
  const nAgents = (run.nodes ?? []).length;
  const summary = `${run.ok ? 'Completed' : 'Completed with issues'} · ${calls} governed call${calls === 1 ? '' : 's'} across ${nAgents} agent${nAgents === 1 ? '' : 's'}`;

  await coverPage(
    p,
    'Results Report',
    system.system.name || 'Agent run',
    summary,
    `Ran by ${meta.ranBy || 'unknown'}  ·  ${new Date(meta.at).toISOString()}  ·  mode: ${run.mode ?? 'live'}`,
  );

  // Run summary block.
  p.subhead('Task');
  p.text(meta.prompt?.trim() || '(default task)', 10);
  p.space(4);
  p.subhead('Path');
  p.text(run.path.length ? `${run.path.join('  →  ')}  →  END` : '(no path)', 10);

  // Final output — the headline result, straight from the run.
  p.heading('Final output');
  p.markdown((run.output ?? '').trim() || '(the run produced no final text)', 10);

  // Per-agent results — one block per agent, exactly the Run cards.
  if (nAgents > 0) {
    p.heading('Per-agent results');
    for (const n of run.nodes ?? []) {
      p.space(4);
      const meta2 = [n.model, n.tier].filter(Boolean).join(' · ');
      const ok = n.status === 'ok';
      p.eyebrow(`${nameOf(n.node)}  —  ${n.status}`, ok ? BRAND.green : BRAND.red);
      const line = `${meta2 ? `${meta2}  ·  ` : ''}${n.steps.length} call${n.steps.length === 1 ? '' : 's'}`;
      p.text(line, 9, false, 13, BRAND.muted);
      const out = (n.finalText ?? '').trim() || '(no output)';
      p.markdown(out.length > 3000 ? `${out.slice(0, 3000)}…` : out, 9);
    }
  }

  paintFooters(doc, brand);
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
  const { doc, p, brand } = await newBrandedDoc();
  const report: EvalReport = buildEvalReport(system, run, checks, judge, meta);
  const nameOf = (id: string) => {
    const a = system.agents.find((x) => x.id === id);
    return a ? agentDisplayName(a) : id;
  };

  await coverPage(
    p,
    'Evaluation Report',
    report.title,
    report.checks.allPass ? 'All checks passed' : `${report.checks.rows.filter((r) => !r.pass).length} check(s) to review`,
    `Ran by ${report.ranBy}  ·  ${report.timestamp}`,
  );

  // ── PAGE 1: the visual system graph ──────────────────────────────────────
  p.heading('Multi-agent system');
  const { svg, width, height } = renderSystemGraphSvg(system, { labelOf: nameOf });
  const png = system.agents.length > 0 ? await svgToPng(svg, width, height, 2.5) : null;
  if (png) {
    const availW = p.W - M - RM;
    const availH = p.H - p.y - M - FOOT;
    const ratio = Math.min(availW / png.w, availH / png.h, 1.6);
    const dw = png.w * ratio;
    const dh = png.h * ratio;
    doc.addImage(png.dataUrl, 'PNG', M + (availW - dw) / 2, p.y, dw, dh);
    p.y += dh + 8;
  } else {
    p.text(system.agents.length === 0 ? 'No agents yet — the graph is empty.' : 'The graph could not be rendered.', 10, false, 15, BRAND.muted);
  }

  // ── MAIN BODY: exactly the Evaluate screen (Checks + AI judge) ────────────
  p.page();
  p.heading('Checks');
  p.text(
    report.checks.allPass ? 'All checks passed.' : `${report.checks.rows.filter((r) => !r.pass).length} check(s) to look at.`,
    10.5,
    true,
    16,
    report.checks.allPass ? BRAND.green : BRAND.red,
  );
  for (const c of report.checks.rows) {
    p.space(4);
    p.eyebrow(c.label, c.pass ? BRAND.green : BRAND.red, c.pass ? BRAND.green : BRAND.red);
    p.text(c.detail, 9.5, false, 14, BRAND.muted);
  }

  if (report.judge) {
    p.heading('AI judge');
    p.text(`Overall ${report.judge.overall} / 5`, 12, true, 18, BRAND.goldText);
    for (const r of report.judge.rows) {
      p.space(4);
      p.eyebrow(`${r.dimension}  —  ${r.score}/5`);
      p.text(r.why, 9.5, false, 14, BRAND.muted);
    }
  }

  // ── APPENDIX 1 — Results ─────────────────────────────────────────────────
  p.page();
  p.heading('Appendix 1 — Results');
  p.subhead('Path');
  p.text(report.results.path, 10);
  p.heading('Final output', 13);
  p.markdown(report.results.finalOutput, 10);
  if (report.results.agents.length > 0) {
    p.heading('Per-agent outputs', 13);
    for (const a of report.results.agents) {
      p.space(4);
      const m = [a.model, a.tier].filter(Boolean).join(' · ');
      p.eyebrow(`${a.name}  —  ${a.decision}`);
      p.text(`${m ? `${m}  ·  ` : ''}${a.calls} call${a.calls === 1 ? '' : 's'}`, 9, false, 13, BRAND.muted);
      p.markdown(a.output.length > 2500 ? `${a.output.slice(0, 2500)}…` : a.output, 9);
    }
  }

  // ── APPENDIX 2 — Define-stage settings ───────────────────────────────────
  p.page();
  p.heading('Appendix 2 — Define-stage settings');
  p.subhead('Team name');
  p.text(report.define.name, 10);
  p.subhead('Purpose / success criteria');
  p.markdown(report.define.purpose, 10);
  p.subhead('Safety preset');
  p.text(report.define.safety, 10);
  p.subhead('Trigger mode');
  p.text(report.define.trigger, 10);
  p.heading('What your team can use', 13);
  if (report.define.grants.length === 0) {
    p.text('Nothing granted.', 10, false, 15, BRAND.muted);
  } else {
    for (const grp of report.define.grants) {
      p.subhead(grp.kind);
      for (const l of grp.lines) p.markdown(`- ${l}`, 9.5);
    }
  }

  // ── APPENDIX 3 — Agent descriptions ──────────────────────────────────────
  p.page();
  p.heading('Appendix 3 — Agent descriptions');
  if (report.agentDescriptions.length === 0) {
    p.text('No agents.', 10, false, 15, BRAND.muted);
  } else {
    report.agentDescriptions.forEach((a, i) => {
      if (i > 0) p.space(8);
      p.eyebrow(a.name, BRAND.goldText);
      p.text(`Role: ${a.role}`, 9.5, false, 14, BRAND.muted);
      p.space(2);
      p.markdown(a.instructions, 9.5);
    });
  }

  paintFooters(doc, brand);
  doc.save(reportFilename(`${system.system.name || 'team'}-evaluation`, meta.at));
}
