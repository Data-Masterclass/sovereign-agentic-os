/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Test doubles for the account connectors: tiny .xlsx/.docx files and a fake Graph / Drive API
 * USER STORY: As a maintainer I want CI to prove the Microsoft 365, OneDrive and Google Drive chat tools
 *             and the spreadsheet import without calling Microsoft or Google.
 * ARCHITECTURE: `zip()` writes a minimal ZIP (stored and deflated entries), enough for real Office parts;
 *   `xlsx()` / `docx()` build documents from cells and paragraphs. `fakeApi()` answers fetches by URL
 *   pattern and records the bearer token and URL of every call, so a test can prove whose token reached
 *   the vendor. Test code only.
 */
import { deflateRawSync } from 'node:zlib';

/** A minimal ZIP: one local header + data per entry, the central directory, the end record. CRCs are 0. */
export function zip(files: Record<string, string>, opts: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = opts.deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(opts.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(opts.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A cell: a string (shared string), a number, or `{ date: serial }` (date-formatted number). */
export type Cell = string | number | { date: number } | null;

/** An .xlsx with the given sheets (rows of cells). Dates use style 1 (numFmtId 14). */
export function xlsx(sheets: Record<string, Cell[][]>, opts: { deflate?: boolean } = {}): Buffer {
  const shared: string[] = [];
  const si = (s: string) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const names = Object.keys(sheets);
  const files: Record<string, string> = {};
  names.forEach((name, n) => {
    const rows = sheets[name].map((cells, r) => {
      const cs = cells.map((c, i) => {
        const ref = `${String.fromCharCode(65 + i)}${r + 1}`;
        if (c === null) return '';
        if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${si(c)}</v></c>`;
        if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
        return `<c r="${ref}" s="1"><v>${c.date}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cs}</row>`;
    }).join('');
    files[`xl/worksheets/sheet${n + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook><sheets>${names.map((nm, n) => `<sheet name="${esc(nm)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${names.map((_, n) => `<Relationship Id="rId${n + 1}" Type="worksheet" Target="worksheets/sheet${n + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  files['xl/styles.xml'] = '<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>';
  return zip(files, opts);
}

/** A .docx with one paragraph per string. */
export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('');
  return zip({ 'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>` }, { deflate: true });
}

export type ApiCall = { url: string; method: string; token: string; body?: string };
export type Route = { match: RegExp; method?: string; reply: (url: URL, init: RequestInit) => { status?: number; json?: unknown; bytes?: Buffer; text?: string; headers?: Record<string, string> } };

/** A fake vendor API: the first matching route answers; an unmatched URL is a 404. Records every call. */
export function fakeApi(routes: Route[]): { fetch: typeof fetch; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url: url.toString(), method, token: String(headers.authorization ?? '').replace(/^Bearer /, ''), ...(init.body ? { body: String(init.body) } : {}) });
    const r = routes.find((x) => x.match.test(`${url.pathname}${url.search}`) && (!x.method || x.method === method));
    const out = r ? r.reply(url, init) : { status: 404, json: { error: 'not found' } };
    const status = out.status ?? 200;
    const bytes = out.bytes ?? Buffer.from(out.text ?? JSON.stringify(out.json ?? {}), 'utf8');
    return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': out.bytes ? 'application/octet-stream' : 'application/json', 'content-length': String(bytes.length), ...(out.headers ?? {}) } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
