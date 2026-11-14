/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    A version ref for a kind that is not git-backed yet
 * USER STORY: As a builder I want to go live with the version I am looking at even for an object
 *             the OS does not yet keep in git — and I want "what is running" to still name a
 *             specific, reproducible version rather than a timestamp that tells me nothing.
 * ARCHITECTURE:
 *   - A content DIGEST of the record's canonical JSON, prefixed so a reader can tell it apart
 *     from a commit sha at a glance (`rev:ab12cd34ef56`, `spec:…`). Two identical records hash
 *     the same; any change a consumer could see produces a different ref.
 *   - This is the honest intermediate: the moment a kind becomes git-backed, its adapter returns
 *     the commit sha instead and nothing above it changes, because the pin treats the ref as
 *     opaque. `docs/components/lifecycle.md` says per kind which form it is on today.
 *   - Key order is normalised, so a record that round-trips through JSON keeps its ref.
 */
import 'server-only';
import { createHash } from 'node:crypto';

/** Every key name in the object graph, sorted — so `JSON.stringify`'s replacer is deterministic. */
function keyNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keyNames(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keyNames(v, out);
    }
  }
  return out;
}

/** `<prefix>:<12 hex>` — a stable, short version ref for one record's content. */
export function contentRef(prefix: string, value: unknown): string {
  const canonical = JSON.stringify(value, [...keyNames(value)].sort());
  return `${prefix}:${createHash('sha256').update(canonical ?? 'null').digest('hex').slice(0, 12)}`;
}
