/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Generates `invoice-table.pdf`, the fixture the live Docling test converts: a two-page invoice
 * whose line items are a ruled table with a header row. Built with jsPDF + jspdf-autotable (both
 * MIT, already os-ui dependencies), so the file is reproducible and contains no real data.
 *
 *   node os-ui/tabs/files/lib/ingest/fixtures/make-invoice-pdf.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: false });
doc.setProperties({ title: 'Invoice AT-2026-119', creationDate: new Date('2026-11-01T00:00:00Z') });
doc.setFontSize(20);
doc.text('Invoice AT-2026-119', 56, 72);
doc.setFontSize(11);
doc.text('Alpine Textiles GmbH - Invoice date: 2026-11-01 - Customer: Northpeak Outdoor', 56, 96);
doc.setFontSize(14);
doc.text('Line items', 56, 130);
autoTable(doc, {
  startY: 142,
  theme: 'grid',
  head: [['Item', 'Quantity', 'Unit price (EUR)', 'Amount (EUR)']],
  body: [
    ['Softshell jacket, women', '260', '27.50', '7150.00'],
    ['Fleece pullover, men', '180', '19.90', '3582.00'],
    ['Merino base layer', '320', '14.25', '4560.00'],
    ['Trekking socks (3-pack)', '500', '6.80', '3400.00'],
  ],
  styles: { fontSize: 11, cellPadding: 6 },
  headStyles: { fillColor: [230, 230, 230], textColor: 20 },
});
doc.addPage();
doc.setFontSize(14);
doc.text('Payment terms', 56, 72);
doc.setFontSize(11);
doc.text('Payment is due within 30 days. An early payment discount of 2 % applies within 10 days.', 56, 96);
doc.text('Total due: 18692.00 EUR', 56, 120);

const out = fileURLToPath(new URL('./invoice-table.pdf', import.meta.url));
writeFileSync(out, Buffer.from(doc.output('arraybuffer')));
console.log(`wrote ${out}`);
