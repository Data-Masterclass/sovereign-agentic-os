/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
import type { OkfBundle, BundleFile } from './okf-model.ts';

/**
 * SERVER-ONLY minimal ZIP reader/writer for OKF bundles. Uses Node's built-in
 * `node:zlib` (DEFLATE) — NO new dependency and NO node builtins leak into the
 * client bundle ('server-only' guards it). Purpose-built so we own the SECURITY
 * boundary end to end (decision #5): zip-slip path sanitisation and hard caps are
 * enforced HERE, at extraction, with honest rejection reasons.
 *
 * We handle the common ZIP shape our own exporter produces and typical archives:
 * local-file-header + DEFLATE/STORE entries, read via the End-Of-Central-Directory
 * record. We deliberately DO NOT support: encryption, ZIP64, multi-disk, or data
 * descriptors without central-directory sizes — such archives are rejected honestly
 * rather than mis-parsed.
 */

// -------------------------------------------------------------- hard caps ------

/** Max total UNPACKED bytes across all files (decision #5: ≤ 50 MB). */
export const OKF_MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
/** Max number of files (decision #5: ≤ 2,000). */
export const OKF_MAX_FILES = 2000;
/** Reject a single entry whose declared uncompressed size alone blows the cap (bomb guard). */
const OKF_MAX_ENTRY_BYTES = OKF_MAX_UNPACKED_BYTES;

export class OkfZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfZipError';
  }
}

// ================================================================= WRITE =======

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * Zip an in-memory bundle to a Buffer. DEFLATE-compresses each file; falls back to
 * STORE when compression doesn't help. Deterministic apart from the timestamp.
 */
export function zipBundle(bundle: OkfBundle, at: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(at);
  const localChunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of bundle.files) {
    const nameBuf = Buffer.from(normalizeWritePath(file.path), 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const crc = crc32(raw) >>> 0;
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const data = useDeflate ? deflated : raw;

    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(raw.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    localChunks.push(lfh, nameBuf, data);

    // Central directory header
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk #
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // local header offset
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }

  const localBuf = Buffer.concat(localChunks);
  const centralBuf = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk #
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(bundle.files.length, 8);
  eocd.writeUInt16LE(bundle.files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** Normalise a path for writing (POSIX separators, no leading slash). */
function normalizeWritePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

// ================================================================= READ ========

/**
 * Sanitise an entry path — the ZIP-SLIP gate. Rejects absolute paths, drive letters,
 * backslashes normalised to `/`, and any `..` traversal. Returns a safe POSIX path,
 * or throws OkfZipError with an honest reason.
 */
export function safeEntryPath(rawName: string): string {
  const name = rawName.replace(/\\/g, '/');
  if (name.startsWith('/')) throw new OkfZipError(`unsafe absolute path in archive: ${rawName}`);
  if (/^[a-zA-Z]:/.test(name)) throw new OkfZipError(`unsafe drive-letter path in archive: ${rawName}`);
  const parts = name.split('/');
  for (const p of parts) {
    if (p === '..') throw new OkfZipError(`unsafe path traversal (..) in archive: ${rawName}`);
  }
  // Collapse `.`/empty segments; the result never escapes the root.
  return parts.filter((p) => p !== '' && p !== '.').join('/');
}

/**
 * Read a ZIP Buffer into an in-memory bundle, enforcing zip-slip sanitisation and
 * the hard caps. Directory entries (trailing `/`) are skipped. Throws OkfZipError
 * with an honest reason on any violation or malformed structure.
 */
export function unzipBundle(buf: Buffer): OkfBundle {
  if (buf.length < 22) throw new OkfZipError('archive too small to be a zip');

  // Locate the End Of Central Directory record (scan back over any comment).
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - 22 - maxComment);
  let eocd = -1;
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new OkfZipError('not a valid zip (no end-of-central-directory record)');

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total > OKF_MAX_FILES) throw new OkfZipError(`archive has ${total} entries — exceeds the ${OKF_MAX_FILES}-file cap`);

  const files: BundleFile[] = [];
  let unpacked = 0;
  let p = cdOffset;

  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) throw new OkfZipError('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue; // directory entry

    if (uncompSize > OKF_MAX_ENTRY_BYTES) throw new OkfZipError(`entry ${rawName} declares ${uncompSize} bytes — exceeds the unpacked cap`);
    unpacked += uncompSize;
    if (unpacked > OKF_MAX_UNPACKED_BYTES) {
      throw new OkfZipError(`archive unpacks to over ${OKF_MAX_UNPACKED_BYTES / (1024 * 1024)} MB — rejected (zip-bomb guard)`);
    }

    // Read the local header to find the data offset (name/extra lengths can differ).
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) throw new OkfZipError('corrupt local file header');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new OkfZipError(`entry ${rawName} data runs past end of archive`);
    const comp = buf.subarray(dataStart, dataEnd);

    let raw: Buffer;
    if (method === 0) {
      raw = Buffer.from(comp);
    } else if (method === 8) {
      try {
        raw = inflateRawSync(comp);
      } catch (e) {
        throw new OkfZipError(`entry ${rawName} failed to inflate — ${(e as Error).message}`);
      }
      if (raw.length > OKF_MAX_ENTRY_BYTES) throw new OkfZipError(`entry ${rawName} inflated past the unpacked cap`);
    } else {
      throw new OkfZipError(`entry ${rawName} uses unsupported compression method ${method}`);
    }

    // Recompute the running total from the ACTUAL inflated size (declared size can lie).
    unpacked = unpacked - uncompSize + raw.length;
    if (unpacked > OKF_MAX_UNPACKED_BYTES) {
      throw new OkfZipError(`archive unpacks to over ${OKF_MAX_UNPACKED_BYTES / (1024 * 1024)} MB — rejected (zip-bomb guard)`);
    }

    const path = safeEntryPath(rawName); // ZIP-SLIP gate
    if (!path) continue;
    files.push({ path, content: raw.toString('utf8') });
  }

  return { files };
}
