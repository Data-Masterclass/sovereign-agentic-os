import localFont from 'next/font/local';

/**
 * Brand typography for the Sovereign Agentic OS, matching
 * www.sovereign-agentic.com:
 *   - Rubik     (body)        — variable weight 300–700
 *   - Oswald    (headings)    — variable weight 400–700, condensed/uppercase
 *   - Marcellus (eyebrow/sub) — serif accent, 400
 *
 * Self-hosted woff2 (latin subset) so the build and the in-cluster runtime
 * are fully offline — no runtime CDN, no build-time font fetch.
 */

export const rubik = localFont({
  src: './fonts/rubik-latin.woff2',
  weight: '300 700',
  style: 'normal',
  display: 'swap',
  variable: '--f-body',
  fallback: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Helvetica',
    'Arial',
    'sans-serif',
  ],
});

export const oswald = localFont({
  src: './fonts/oswald-latin.woff2',
  weight: '400 700',
  style: 'normal',
  display: 'swap',
  variable: '--f-head',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
});

export const marcellus = localFont({
  src: './fonts/marcellus-latin.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  variable: '--f-sub',
  fallback: ['Georgia', 'Times New Roman', 'serif'],
});
