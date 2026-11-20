/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Write an OPA bundle file: a gzipped tarball holding `.manifest` and `data.json`.
 * USER STORY: As an operator I want the bundles os-ui serves to be byte-identical for identical
 *             content, so the same data always carries the same revision and ETag.
 * ARCHITECTURE:
 *   - The bundle file format is OPA's (https://www.openpolicyagent.org/docs/management-bundles#bundle-file-format):
 *     a gzipped tarball whose `.manifest` names the revision and roots and whose `data.json` files
 *     hold the data. The tar is POSIX ustar (regular files only), written with fixed mode, owner
 *     and mtime 0, so the output depends on the content alone. gzip is Node's built-in zlib.
 *   - OPA itself is the parser and the proof (tests/opa/bundle*.int.test.ts load these bytes in
 *     the pinned OPA image); there is no reader here.
 */
import { gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(n: number, width: number): string {
  // width includes the trailing NUL.
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number): Buffer {
  const name8 = Buffer.from(name, 'utf8');
  if (name8.length > 100) throw new Error(`bundle-tar: file name too long: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  name8.copy(h, 0);
  h.write(octal(0o644, 8), 100, 'ascii'); // mode
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(size, 12), 124, 'ascii'); // size
  h.write(octal(0, 12), 136, 'ascii'); // mtime
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  h.write('0', 156, 'ascii'); // typeflag: regular file
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/** A gzipped ustar archive of `files` (in the given order). Deterministic for identical input. */
export function tarGz(files: { name: string; content: string | Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    parts.push(header(f.name, body.length), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive marker
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** JSON with object keys sorted at every level: the canonical form the revision is hashed from. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
