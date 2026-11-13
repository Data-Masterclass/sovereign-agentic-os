/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Minimal ustar (POSIX tar) writer for repo exports
 * USER STORY: As a data engineer I want to download a domain's dbt project at a commit as a
 *             plain tar I can `tar xf` and `dbt parse`, without the OS depending on a tar library.
 * ARCHITECTURE:
 *   - Pure: entries in → Buffer out. Regular files only (mode 0644), ustar magic, long paths
 *     split into the 155-byte prefix field. Deterministic for a fixed mtime (the commit time).
 *   - Zero dependencies — one of the two reasons it exists (the other: the Node stdlib has none).
 */

export type TarEntry = { path: string; content: Uint8Array; mtime: number };

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function splitPath(p: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(p, 'utf8');
  if (bytes <= 100) return { name: p, prefix: '' };
  const idx = p.lastIndexOf('/', p.length - 2);
  if (idx <= 0) throw new Error(`tar: path too long for ustar (${bytes} bytes): ${p}`);
  const prefix = p.slice(0, idx);
  const name = p.slice(idx + 1);
  if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`tar: path too long for ustar: ${p}`);
  }
  return { name, prefix };
}

function header(entry: TarEntry): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitPath(entry.path);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(entry.content.byteLength, 12), 124, 12, 'ascii');
  h.write(octal(Math.max(0, Math.floor(entry.mtime)), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces while summing)
  h.write('0', 156, 1, 'ascii'); // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('os', 265, 32, 'ascii');
  h.write('os', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** Build a tar archive. Entries are written in the order given; pass them sorted for a stable result. */
export function tarArchive(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e));
    parts.push(Buffer.from(e.content));
    const pad = (BLOCK - (e.content.byteLength % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** Read the file names + contents back out of a ustar archive (tests + sanity checks). */
export function tarList(buf: Buffer): { path: string; content: Buffer }[] {
  const out: { path: string; content: Buffer }[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const start = off + BLOCK;
    out.push({ path: prefix ? `${prefix}/${name}` : name, content: Buffer.from(buf.subarray(start, start + size)) });
    off = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  return out;
}
