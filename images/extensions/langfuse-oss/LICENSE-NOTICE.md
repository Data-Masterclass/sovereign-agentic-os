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

Third-party packages keep their own licence files in `node_modules/`. The licence of every package in
the image is checked on the built image by `scripts/license-gate-image.mjs` (scope `langfuse-oss`).
Alpine Linux base packages are not scanned by that gate (same as every image of this repository).
