/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      os-ui's own package-lock.json path (Node-only)
 * USER STORY:   As a builder, an agent module pins and imports exactly the packages os-ui runs.
 * ARCHITECTURE: OS_UI_LOCKFILE when set (the image sets /app/package-lock.json), else
 *               `<cwd>/package-lock.json`. Kept OUT of config.ts, which the Edge middleware imports
 *               and where process.cwd() throws. Read by tabs/agents/lib/module/versions.ts and
 *               core/adapters/agent-module/load.ts.
 */
import path from 'node:path';
import { config } from '@core/kernel/config';

/** Fixed when this module loads (os-ui's working directory at boot), as config.ts did before. */
const DEFAULT_LOCKFILE = path.join(process.cwd(), 'package-lock.json');

export function hostLockfilePath(): string {
  return config.agentModuleHostLockfile || DEFAULT_LOCKFILE;
}
