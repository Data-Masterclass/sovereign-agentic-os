/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Per-component documentation (server-only).
 *
 * Reads the `docs/components/<id>.md` markdown that used to be served by the
 * standalone admin-console. The OS UI image bakes `docs/components` in (see
 * images/os-ui/Dockerfile), so this reads it straight off disk — no cross-pod
 * fetch. The id is sanitised to an alnum/-/_ alphabet so it can never escape
 * the docs directory.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Candidate roots, in priority order:
//   1. DOCS_DIR override (set in the chart / for tests)
//   2. <cwd>/docs/components      — the baked-in image layout (cwd = /app)
//   3. <cwd>/../docs/components   — local dev (`next` runs with cwd = os-ui/)
function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.DOCS_DIR) dirs.push(process.env.DOCS_DIR);
  dirs.push(path.join(process.cwd(), 'docs', 'components'));
  dirs.push(path.join(process.cwd(), '..', 'docs', 'components'));
  return dirs;
}

export function readComponentDoc(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return '# Unknown\n\n_No doc yet._';
  for (const dir of candidateDirs()) {
    const file = path.join(dir, `${safe}.md`);
    try {
      if (existsSync(file)) return readFileSync(file, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  return `# ${safe}\n\n_No doc yet._`;
}
