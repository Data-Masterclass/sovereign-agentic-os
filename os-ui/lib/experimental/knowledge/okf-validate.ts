/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import { RESERVED_FILES, splitFrontmatter, basename, type OkfBundle } from './okf-model.ts';

/**
 * OKF v0.2 conformance validation — runs on every export AND every import (locked
 * decision #7). Pure module (no server/network). It encodes the spec's THREE
 * conformance rules and the graceful-degradation stance precisely:
 *
 *   Rule 1: every non-reserved `.md` file has PARSEABLE YAML frontmatter.
 *   Rule 2: every frontmatter block has a NON-EMPTY `type`.
 *   Rule 3: reserved files (index.md / log.md) are well-formed WHEN PRESENT.
 *
 * A bundle is REJECTED only on a Rule 1/2/3 failure. It is NEVER rejected for:
 * missing optional fields, UNKNOWN `type` values, unknown extra frontmatter keys,
 * broken cross-links, or absent index.md files — those are `notes`, not errors.
 */

export type OkfValidationIssue = {
  /** `error` fails conformance (bundle rejected); `note` is a graceful-degradation observation. */
  level: 'error' | 'note';
  path: string;
  message: string;
};

export type OkfValidationResult = {
  ok: boolean;
  errors: OkfValidationIssue[];
  notes: OkfValidationIssue[];
};

function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

function isReserved(path: string): boolean {
  return RESERVED_FILES.has(basename(path).toLowerCase());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an in-memory bundle for OKF v0.2 conformance. Errors ⇒ not conformant
 * (reject); notes are advisory (accept). Unknown types / broken links / missing
 * index are notes by design (spec: consumers MUST NOT reject for them).
 */
export function validateBundle(bundle: OkfBundle): OkfValidationResult {
  const errors: OkfValidationIssue[] = [];
  const notes: OkfValidationIssue[] = [];
  const paths = new Set(bundle.files.map((f) => f.path));

  for (const file of bundle.files) {
    if (!isMarkdown(file.path)) continue;

    if (isReserved(file.path)) {
      // Rule 3: reserved files must be well-formed WHEN PRESENT. index.md/log.md
      // MAY carry frontmatter (log.md often does: `type: Log`); if it does, it must
      // parse. index.md is a plain directory listing — a parse of an empty/no
      // frontmatter body is fine.
      const { raw } = splitFrontmatter(file.content);
      if (raw !== null) {
        try {
          const parsed = yaml.load(raw);
          if (parsed !== null && parsed !== undefined && !isRecord(parsed)) {
            errors.push({ level: 'error', path: file.path, message: 'reserved file frontmatter must be a YAML mapping' });
          }
        } catch (e) {
          errors.push({ level: 'error', path: file.path, message: `reserved file has unparseable YAML frontmatter — ${(e as Error).message}` });
        }
      }
      continue;
    }

    // Non-reserved concept doc — Rules 1 & 2.
    const { raw } = splitFrontmatter(file.content);
    if (raw === null) {
      errors.push({ level: 'error', path: file.path, message: 'concept document is missing YAML frontmatter (--- … ---)' });
      continue;
    }
    let front: unknown;
    try {
      front = yaml.load(raw);
    } catch (e) {
      errors.push({ level: 'error', path: file.path, message: `unparseable YAML frontmatter — ${(e as Error).message}` });
      continue;
    }
    if (!isRecord(front)) {
      errors.push({ level: 'error', path: file.path, message: 'frontmatter must be a YAML mapping' });
      continue;
    }
    const type = typeof front.type === 'string' ? front.type.trim() : '';
    if (!type) {
      errors.push({ level: 'error', path: file.path, message: 'frontmatter is missing a non-empty `type` (the only required key)' });
      continue;
    }

    // --- graceful-degradation observations (NOTES, never errors) ---
    // Broken relative cross-links: note them so the UI can flag, never reject.
    for (const link of relativeMdLinks(file.content)) {
      const resolved = resolvePath(file.path, link);
      if (resolved && !paths.has(resolved)) {
        notes.push({ level: 'note', path: file.path, message: `link target not found in bundle: ${link}` });
      }
    }
  }

  // Missing index.md is a NOTE, not an error (spec: consumers must handle absence).
  const dirs = new Set<string>();
  for (const f of bundle.files) {
    const i = f.path.lastIndexOf('/');
    dirs.add(i === -1 ? '' : f.path.slice(0, i));
  }
  for (const dir of dirs) {
    const indexPath = dir ? `${dir}/index.md` : 'index.md';
    if (!paths.has(indexPath)) notes.push({ level: 'note', path: indexPath, message: 'directory has no index.md (allowed; consumers degrade gracefully)' });
  }

  return { ok: errors.length === 0, errors, notes };
}

/** Extract relative markdown link targets (`[text](target)`), skipping absolute URLs and anchors. */
export function relativeMdLinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const target = m[1].trim().split(/\s+/)[0]; // drop optional "title"
    if (!target || target.startsWith('#')) continue;
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('mailto:')) continue; // external URL
    if (!target.toLowerCase().split('#')[0].endsWith('.md')) continue; // only intra-bundle concept links
    out.push(target.split('#')[0]);
  }
  return out;
}

/**
 * Resolve a relative link from a source file path to a normalised bundle path.
 * Bundle-absolute links (leading `/`) resolve from the bundle root. Returns null on
 * an escape attempt (defence in depth; the zip layer is the real zip-slip gate).
 */
export function resolvePath(fromFile: string, link: string): string | null {
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const base = link.startsWith('/') ? '' : fromDir;
  const parts = (base ? base.split('/') : []).concat(link.replace(/^\//, '').split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (stack.length === 0) return null; // escapes the bundle root
      stack.pop();
    } else {
      stack.push(p);
    }
  }
  return stack.join('/');
}
