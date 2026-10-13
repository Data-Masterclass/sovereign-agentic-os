/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { zipBundle, unzipBundle, safeEntryPath, OkfZipError, OKF_MAX_FILES } from './okf-zip.ts';
import type { OkfBundle } from './okf-model.ts';

test('zipBundle → unzipBundle round-trips files byte-for-byte', () => {
  const bundle: OkfBundle = {
    files: [
      { path: 'index.md', content: '# Subdirectories\n\n* [a](a/index.md)\n' },
      { path: 'a/concept.md', content: '---\ntype: term\ntitle: T\n---\n\nÜnïcödé body ✓\n' },
    ],
  };
  const zip = zipBundle(bundle);
  const back = unzipBundle(zip);
  assert.equal(back.files.length, 2);
  const byPath = new Map(back.files.map((f) => [f.path, f.content]));
  assert.equal(byPath.get('index.md'), bundle.files[0].content);
  assert.equal(byPath.get('a/concept.md'), bundle.files[1].content);
});

test('safeEntryPath: rejects zip-slip (.., absolute, drive-letter), sanitises the rest', () => {
  assert.throws(() => safeEntryPath('../../etc/passwd'), OkfZipError);
  assert.throws(() => safeEntryPath('/etc/passwd'), OkfZipError);
  assert.throws(() => safeEntryPath('C:\\windows\\x'), OkfZipError);
  assert.throws(() => safeEntryPath('a/../../b'), OkfZipError);
  assert.equal(safeEntryPath('a/./b.md'), 'a/b.md');
  assert.equal(safeEntryPath('dir\\file.md'), 'dir/file.md');
});

test('unzipBundle: a crafted zip-slip entry is rejected with an honest reason', () => {
  // Build a minimal zip whose single entry name is a traversal path.
  const zip = makeSingleEntryZip('../evil.md', 'pwned');
  assert.throws(() => unzipBundle(zip), (e: unknown) => e instanceof OkfZipError && /path traversal/.test((e as Error).message));
});

test('unzipBundle: enforces the file-count cap', () => {
  // Forge an EOCD claiming too many entries — must be rejected before parsing.
  const files: { path: string; content: string }[] = [];
  const bundle: OkfBundle = { files: [{ path: 'a.md', content: 'x' }] };
  void files;
  const zip = zipBundle(bundle);
  // Patch the EOCD total-entries field to exceed the cap.
  const eocd = zip.length - 22;
  zip.writeUInt16LE(OKF_MAX_FILES + 1, eocd + 10);
  assert.throws(() => unzipBundle(zip), (e: unknown) => e instanceof OkfZipError && /file cap/.test((e as Error).message));
});

test('unzipBundle: rejects a non-zip buffer honestly', () => {
  assert.throws(() => unzipBundle(Buffer.from('not a zip at all, just text padding padding padding')), OkfZipError);
});

// --- helper: forge a single-entry zip with an arbitrary (possibly malicious) name.
function makeSingleEntryZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const crc = crc32(raw) >>> 0;
  const data = deflateRawSync(raw);

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(raw.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(raw.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);

  const localBuf = Buffer.concat([lfh, nameBuf, data]);
  const centralBuf = Buffer.concat([cdh, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}
