/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';

/**
 * "Instant preview" — the inner-loop preview for a governed frontend app.
 *
 * SOVEREIGN LICENSING NOTE: this used to bundle the app's frontend in-browser with
 * `@codesandbox/sandpack-react`, which transitively pulls `@codesandbox/nodebox`
 * under the proprietary "Sustainable Use License" (NON-permissive). For a strictly
 * MIT/Apache/BSD/ISC OS that dependency is not allowed, so the CodeSandbox chain has
 * been removed (`npm run check:licenses` now passes).
 *
 * The working preview is the REAL deployed build served by the app runner
 * (`deploy.previewUrl`): a same-origin-cookie'd browser session against the live,
 * governed OS API, so it shows the user's REAL granted data (or the app's own honest
 * error) — never mocked. It is clearly labelled as the deployed build, and honest
 * states are shown while the runner is still provisioning.
 *
 * The `/api/software/[id]/preview-files` route is intentionally KEPT (it already
 * injects the vendored `@sovereign-os/app-sdk`) so a future permissive in-browser
 * bundler can reuse it — see TODO(instant-preview-esbuild-wasm) below.
 *
 * TODO(instant-preview-esbuild-wasm): restore a sub-second, no-deploy inner-loop
 * preview using a strictly-permissive toolchain:
 *   1. Add `esbuild-wasm` (MIT). Initialise it CLIENT-ONLY (wrap in `useEffect`, and
 *      keep this component behind `next/dynamic({ ssr:false })` so SSR/prerender is
 *      never touched).
 *   2. Fetch `/api/software/[id]/preview-files` (already returns the app's `src/*`
 *      plus the vendored SDK). Build an esbuild in-browser plugin whose resolver
 *      serves modules from that virtual FS, and resolves the bare deps
 *      (`react`, `react-dom/client`, `@radix-ui/react-slot`, `clsx`, `tailwind-merge`)
 *      from a NEW same-origin ESM route + an import-map — NO external CDN egress, so
 *      the preview stays sovereign/air-gappable.
 *   3. Process Tailwind for the preview with a permissive in-browser JIT
 *      (`@tailwindcss/browser`, MIT) so the utility-class-heavy scaffolds render
 *      faithfully — the piece Sandpack did for us and the reason a naked esbuild
 *      bundle is not yet a faithful preview.
 *   4. Render the bundled JS in a sandboxed SAME-ORIGIN iframe so the SDK's
 *      `fetch(credentials:'include')` still carries the `soa_session` cookie to the
 *      governed OS routes → real granted data, or a real typed error. Never mock.
 * Until then, the deployed build below IS the honest, working preview.
 */

export default function InstantPreview({
  appId,
  previewUrl,
}: {
  appId: string;
  previewUrl: string | null;
}) {
  // Reload the iframe when the app changes (e.g. after a Build commit + redeploy).
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setNonce((n) => n + 1);
  }, [appId, previewUrl]);

  if (!previewUrl) {
    return (
      <p className="hint" style={{ marginTop: 0 }}>
        Preview appears once the app runner is provisioned. Use “Provision preview” below to
        build & deploy it — it then renders here against the governed OS API, as you.
      </p>
    );
  }

  return (
    <div>
      <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        Deployed build (live data) — the real app served by the runner, calling the governed OS
        API as you. It shows your real granted data, or the app’s own honest error.
      </div>
      <iframe
        key={nonce}
        src={previewUrl}
        title="App preview"
        style={{ width: '100%', height: 520, border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, background: '#fff' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
