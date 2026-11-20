/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    The AT-a fixture: a 2-page contract PDF whose answer sits in a table cell on page 2
 * USER STORY: As AT-a I want a PDF where "notice period 90 days" is in a drawn table on page 2 and
 *             shares NO word with the query "how long before I can leave the deal?", so only
 *             semantic (k-NN) retrieval over Docling's table-aware chunks can find it.
 * ARCHITECTURE:
 *   - Generated, not committed as a binary: a minimal PDF 1.4 (Helvetica, text + stroked grid).
 *   - QUERY_WORDS is checked against every word on both pages at build time.
 */
export const QUERY = 'how long before I can leave the deal?';
export const ANSWER_CELL = '90 days';

const PAGE1 = [
  [72, 740, 18, 'Master Services Agreement'],
  [72, 700, 11, 'Parties: Northpeak GmbH (customer) and Acme Supplies Ltd (supplier).'],
  [72, 682, 11, 'Scope: supply of spare parts for service centres across Europe.'],
  [72, 664, 11, 'Pricing: fixed unit prices per Annex A, invoiced monthly.'],
  [72, 646, 11, 'Termination terms are set out in Annex B on page 2.'],
];
const PAGE2_TITLE = [72, 740, 16, 'Annex B - Termination terms'];
const TABLE = [
  ['Clause', 'Term'],
  ['Notice period', ANSWER_CELL],
  ['Termination fee', 'none'],
  ['Renewal', 'automatic, 12 months'],
];

const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const QUERY_WORDS = new Set(words(QUERY));
const allText = [...PAGE1.map((l) => l[3]), PAGE2_TITLE[3], ...TABLE.flat()].join(' ');
const shared = words(allText).filter((w) => QUERY_WORDS.has(w));
if (shared.length) throw new Error(`fixture shares words with the query: ${[...new Set(shared)].join(', ')}`);

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const text = ([x, y, size, s]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`;

function page2() {
  const ops = [text(PAGE2_TITLE)];
  const x0 = 72, colW = [180, 200], rowH = 24, yTop = 700;
  const width = colW[0] + colW[1];
  ops.push('0.8 w');
  for (let r = 0; r <= TABLE.length; r++) ops.push(`${x0} ${yTop - r * rowH} m ${x0 + width} ${yTop - r * rowH} l S`);
  for (const x of [x0, x0 + colW[0], x0 + width]) ops.push(`${x} ${yTop} m ${x} ${yTop - TABLE.length * rowH} l S`);
  TABLE.forEach((row, r) => row.forEach((cell, c) => ops.push(text([x0 + 6 + (c ? colW[0] : 0), yTop - (r + 1) * rowH + 8, 11, cell]))));
  return ops.join('\n');
}

export function contractPdf() {
  const streams = [PAGE1.map(text).join('\n'), page2()];
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    ...streams.map((s) => `<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- Distractor corpus (AT-a retrieval). Every page USES the query's words and none carries the
// answer, so (1) a keyword match ranks a distractor first, and (2) the corpus is far larger than any
// top-k, so the answer chunk at rank 1 can only come from semantic (k-NN) retrieval.
export const DISTRACTOR_PAGES = 36;
export const DISTRACTOR_MARKER = 'Kickoff memo';
export function distractorPdf(pages = DISTRACTOR_PAGES) {
  const streams = [];
  for (let i = 1; i <= pages; i++) {
    streams.push([
      [72, 740, 16, `${DISTRACTOR_MARKER} ${i}`],
      [72, 700, 11, `How long before the deal team can leave the kickoff meeting ${i}?`],
      [72, 682, 11, `I can confirm the deal room stays open; leave requests go to the workstream lead ${i}.`],
    ].map(text).join('\n'));
  }
  const n = streams.length;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${streams.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${n} >>`];
  const fontObj = 3 + 2 * n;
  streams.forEach((_, i) => objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${3 + n + i} 0 R >>`));
  streams.forEach((s) => objs.push(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`));
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Embedding rules for the model stub: the query and the answer row share topic 1; nothing else
 * matches a rule, so distractors keep meaningless hashed vectors far from topic 1.
 */
export const EMBEDDING_RULES = [
  { contains: QUERY, topic: 1 },
  { contains: 'Notice period', topic: 1 },
];
