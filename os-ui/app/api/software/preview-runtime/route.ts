/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { requireUser } from '@/lib/core/auth';
import { getPreviewRuntimeAsset } from '@/lib/software/preview-runtime';

export const dynamic = 'force-dynamic';

/**
 * Same-origin runtime assets for the in-browser "Instant preview" bundler.
 *
 * The Instant preview compiles the app's own `src/*` in the browser with
 * esbuild-wasm, but the bundle's bare deps (`react`, `react-dom/client`,
 * `react/jsx-runtime`) and the esbuild wasm binary must come from SOMEWHERE with
 * NO external CDN egress — a sovereign / air-gappable OS never phones home. This
 * route is that somewhere: it serves the runtime straight from os-ui's OWN
 * node_modules (React 19, MIT), pre-bundled server-side into ESM facades whose
 * import specifiers the preview's import-map points at.
 *
 *   GET /api/software/preview-runtime?asset=react
 *                                    |=react-dom-client
 *                                    |=jsx-runtime
 *                                    |=wasm
 *
 * VIEW-gated only (`requireUser`): it ships permissive React source + the esbuild
 * wasm, never any governed data. Built once and cached in module memory.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(); // any signed-in user may load the preview runtime
    const asset = new URL(req.url).searchParams.get('asset') ?? '';
    const out = await getPreviewRuntimeAsset(asset);
    if (!out) {
      return new Response(JSON.stringify({ error: `Unknown runtime asset: ${asset}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(out.body, {
      status: 200,
      headers: {
        'content-type': out.contentType,
        // Immutable per build; safe to cache in the browser for the session.
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}
