<!-- SPDX-License-Identifier: Apache-2.0 -->
# langfuse-oss images — licence notice

These images contain **Langfuse 3.194.1** (https://github.com/langfuse/langfuse, commit
`a75766c15365b668c8517cbfea2e6347d465ce8d`), built from source by `images/extensions/langfuse-oss/` of
the Sovereign Agentic OS repository (https://github.com/Data-Masterclass/sovereign-agentic-os).

**Not included:** the directories that Langfuse's root `LICENSE` places under the Langfuse Enterprise
License: `ee/`, `web/src/ee/` and `worker/src/ee/`. They are deleted before the build
(`prepare-source.mjs`), and the build fails if any of their code is found in the output
(`verify-build.sh`). Nothing in these images is derived from them.

**Langfuse (everything else)** is MIT-licensed. The full text, with Langfuse's licence statement, is at
`/usr/share/licenses/langfuse-oss/LANGFUSE-LICENSE`:

> Copyright (c) 2023-2026 Langfuse GmbH — MIT Expat licence (see the file for the full text).

**Our modifications** (Apache-2.0, Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)), all
original code:
- `web/src/features/oss-unavailable/` and `worker/src/oss-unavailable/`: stubs that keep the names Langfuse's
  MIT code imports from the removed EE modules and report the feature as unavailable;
- `web/src/components/nav/in-app-ai-agent-button.tsx`: replaced, renders nothing;
- every import of an EE module points at its stub; the `@langfuse/ee` workspace package is removed from
  `web/package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml`; 13 MIT test files that test EE code are
  deleted;
- the web build has the base path `/tools/langfuse` (`NEXT_PUBLIC_BASE_PATH`).

**Not included either:** sharp's prebuilt libvips (LGPL-3.0-or-later) and the copy of `@vercel/og`
(MPL-2.0) that Next.js vendors in `next/dist/compiled/`; Langfuse uses neither.

**Third-party packages.** Each npm package in the image carries its own licence files (LICENSE, LICENCE,
COPYING, NOTICE) next to it in `node_modules/`. Next.js's standalone output drops them, so the web build
copies them back from the full install (`ship-licence-files.mjs`). Some packages publish no licence file
at all; they are listed in `/usr/share/licenses/langfuse-oss/packages-without-licence-file.txt`, and the
full text of every licence the packages are under is in `/usr/share/licenses/langfuse-oss/texts/`.
The packages whose licence is not MIT or Apache-2.0 are listed, with their licence, in the Sovereign
Agentic OS repository: `licenses/notices/langfuse-oss-web-image.md` and
`licenses/notices/langfuse-oss-worker-image.md`.

The licence of every package, and the presence of its licence text, is checked on the built image by
`scripts/license-gate-image.mjs` (scope `langfuse-oss`, `--licence-texts`). Alpine Linux base packages
are not scanned by that gate (same as every image of this repository).
