/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Safe element overrides for the markdown renderer of model / agent output
 * USER STORY: As a user reading an assistant answer I want the page to never fetch anything on its
 *             own because of what the model wrote, so that content the model read (a page, a file,
 *             a mail) cannot make my browser send data anywhere without my click.
 * ARCHITECTURE:
 *   - Pure helpers + react-markdown `components` overrides built with createElement (no JSX), so
 *     the node test runner can render the real react-markdown pipeline against them.
 *   - Images: only same-origin relative paths render as <img>. Anything else (absolute http(s),
 *     protocol-relative, data:, other schemes) becomes a text link "[image: host]" that loads
 *     nothing until the user clicks it.
 *   - Links: external links open in a new tab with rel="noopener noreferrer nofollow" and show the
 *     destination host next to the link text, so the user sees where a click goes. Plain <a>
 *     elements are never prefetched (only next/link prefetches).
 *   - Raw HTML in the markdown is skipped by the renderer (skipHtml), so `<img>` written as HTML
 *     never reaches the DOM either. The OS-wide CSP (core/kernel/csp.ts) is the second layer.
 */
import { createElement, type ComponentPropsWithoutRef, type ReactNode } from 'react';

/** Strip the characters browsers ignore or normalise inside URLs before we classify them. */
function normalise(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000- \u007f]/g, '');
}

/**
 * True only for a same-origin RELATIVE path: starts with one "/" (not "//"), or is a plain
 * relative path with no scheme. Backslashes are refused (browsers treat "/\host" as "//host").
 */
export function isSameOriginRelative(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false;
  const s = normalise(raw);
  if (s === '') return false;
  if (s.includes('\\')) return false;
  if (s.startsWith('//')) return false;
  // A scheme is "letters/digits/+.- followed by ':'" before any '/', '?' or '#'.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  return true;
}

/** True for an absolute URL that points away from this origin (http(s) or protocol-relative). */
export function isExternalUrl(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false;
  const s = normalise(raw);
  return /^(https?:)?\/\//i.test(s) || /^https?:/i.test(s) || s.includes('\\');
}

/** The host a URL points to, for display ("example.com"); a best-effort label otherwise. */
export function displayHost(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown source';
  const s = normalise(raw).replace(/\\/g, '/');
  try {
    const u = new URL(s.startsWith('//') ? `https:${s}` : s);
    if (u.host) return u.host;
    return `${u.protocol.replace(/:$/, '')} link`;
  } catch {
    return 'unknown source';
  }
}

const EXTERNAL_REL = 'noopener noreferrer nofollow';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

type AProps = ComponentPropsWithoutRef<'a'> & { node?: unknown };
type ImgProps = ComponentPropsWithoutRef<'img'> & { node?: unknown };

/** Link override: new tab, safe rel, external host shown next to the text. */
export function SafeLink({ href, children, node: _node, ...rest }: AProps) {
  void _node;
  if (!isExternalUrl(href)) {
    return createElement('a', { ...rest, href, target: '_blank', rel: EXTERNAL_REL }, children);
  }
  const host = displayHost(href);
  const showsHost = textOf(children).includes(host);
  return createElement(
    'a',
    { ...rest, href, target: '_blank', rel: EXTERNAL_REL, referrerPolicy: 'no-referrer', title: href },
    children,
    showsHost ? null : createElement('span', { className: 'md-link-host' }, ` (${host})`),
  );
}

/** Image override: same-origin relative paths render; everything else is a non-loading link. */
export function SafeImage({ src, alt, node: _node, ...rest }: ImgProps) {
  void _node;
  const url = typeof src === 'string' ? src : undefined;
  if (url && isSameOriginRelative(url)) {
    return createElement('img', { ...rest, src: url, alt: alt ?? '', loading: 'lazy', referrerPolicy: 'no-referrer' });
  }
  const host = displayHost(url);
  const label = alt ? `[image: ${alt} — ${host}]` : `[image: ${host}]`;
  // Only http(s) targets become clickable; anything else (data:, odd schemes) is plain text.
  if (url && /^https?:/i.test(normalise(url))) {
    return createElement(
      'a',
      { href: url, target: '_blank', rel: EXTERNAL_REL, referrerPolicy: 'no-referrer', title: url, className: 'md-blocked-image' },
      label,
    );
  }
  return createElement('span', { className: 'md-blocked-image' }, label);
}

/** The element overrides every model-output markdown surface uses. */
export const SAFE_MARKDOWN_COMPONENTS = { a: SafeLink, img: SafeImage } as const;
