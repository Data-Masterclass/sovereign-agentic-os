/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * A tiny, dependency-free ZIP writer (STORE method — no compression) plus a reader
 * for the entry names. Enough to assemble a Superset `import_assets` bundle (a folder
 * of small YAML files) as a real .zip that Superset's importer (Python `zipfile`)
 * accepts. Stored entries are universally readable; we don't need DEFLATE for a
 * handful of tiny text files.
 *
 * Pure (no Node/Next imports) so it is directly unit-testable. Bytes are laid out per
 * the PKZIP APPNOTE: local file header + data per entry, then the central directory,
 * then the end-of-central-directory record.
 */

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a STORE-method .zip from a { path → text } map. Entries are sorted so the
 *  archive is byte-deterministic (idempotent bundles for the same dashboard spec). */
export function zipBundle(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const entries = Object.keys(files)
    .sort()
    .map((name) => {
      const nameBytes = enc.encode(name);
      const data = enc.encode(files[name]);
      return { nameBytes, data, crc: crc32(data) };
    });

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const local = new Uint8Array(30 + e.nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed to extract
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // method: 0 = store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0x21, true); // mod date = 1980-01-01 (a valid DOS date)
    dv.setUint32(14, e.crc, true);
    dv.setUint32(18, e.data.length, true); // compressed size
    dv.setUint32(22, e.data.length, true); // uncompressed size
    dv.setUint16(26, e.nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra length
    local.set(e.nameBytes, 30);
    parts.push(local, e.data);

    const cd = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset of local header
    cd.set(e.nameBytes, 46);
    central.push(cd);

    offset += local.length + e.data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  ev.setUint16(20, 0, true); // comment length

  const all = [...parts, ...central, end];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Read back the entry names by scanning local file headers. For tests/inspection. */
export function zipEntryNames(zip: Uint8Array): string[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const names: string[] = [];
  let i = 0;
  const dec = new TextDecoder();
  while (i + 30 <= zip.length && dv.getUint32(i, true) === 0x04034b50) {
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const dataLen = dv.getUint32(i + 18, true);
    const name = dec.decode(zip.subarray(i + 30, i + 30 + nameLen));
    names.push(name);
    i += 30 + nameLen + extraLen + dataLen;
  }
  return names;
}
